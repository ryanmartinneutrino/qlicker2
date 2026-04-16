import Question from '../models/Question.js';
import Course from '../models/Course.js';
import Session from '../models/Session.js';
import Response from '../models/Response.js';
import User from '../models/User.js';
import {
  buildDetachedQuestionManagerCopyPayload,
  buildQuestionManagerFingerprint,
} from '../services/questionManager.js';
import { exportQuestionsToLatexArchive, parseLatexQuestionSet } from '../services/questionLatex.js';
import { copyQuestionToLibrary } from '../services/questionCopy.js';
import { notifyQuestionManagerChanged } from '../services/questionManagerRealtime.js';

const QUESTION_MANAGER_LIST_SCHEMA = {
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      q: { type: 'string' },
      tags: { type: 'string' },
      courseId: { type: 'string' },
      creatorId: { type: 'string' },
      ownerId: { type: 'string' },
      standalone: { type: 'string', enum: ['all', 'standalone', 'course'] },
      duplicates: { type: 'string', enum: ['all', 'duplicates'] },
      all: { type: 'boolean' },
    },
    additionalProperties: false,
  },
};

const EXPORT_LATEX_SCHEMA = {
  body: {
    type: 'object',
    required: ['questionIds'],
    properties: {
      questionIds: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
      },
      includePoints: { type: 'boolean' },
    },
    additionalProperties: false,
  },
};

const ASSIGN_COURSES_SCHEMA = {
  body: {
    type: 'object',
    required: ['questionIds', 'courseIds'],
    properties: {
      questionIds: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
      },
      courseIds: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
      },
    },
    additionalProperties: false,
  },
};

function parseDelimitedValues(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseDelimitedValues(entry));
  }
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildCourseLabel(course = {}) {
  const code = [course?.deptCode, course?.courseNumber].filter(Boolean).join(' ').trim();
  const section = String(course?.section || '').trim();
  const semester = String(course?.semester || '').trim();
  const name = String(course?.name || '').trim();
  const shortTitle = code || name || 'Course';
  const base = [shortTitle, section].filter(Boolean).join(' · ');
  return semester ? `${base} (${semester})` : base;
}

function buildUserSummary(user = {}, count = 0) {
  const firstname = String(user?.profile?.firstname || '').trim();
  const lastname = String(user?.profile?.lastname || '').trim();
  const displayName = `${firstname} ${lastname}`.trim() || String(user?.email || user?.emails?.[0]?.address || user?._id || '').trim();
  const email = String(user?.email || user?.emails?.[0]?.address || '').trim();
  return {
    userId: String(user?._id || '').trim(),
    displayName,
    email,
    count,
  };
}

function getTimestamp(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isQuestionSessionLinked(question, linkedSessionIdsByQuestionId) {
  const questionId = String(question?._id || '').trim();
  if (String(question?.sessionId || '').trim()) return true;
  return (linkedSessionIdsByQuestionId.get(questionId) || 0) > 0;
}

async function getManagedCourseIdsForUser(user) {
  if ((user?.roles || []).includes('admin')) {
    const courses = await Course.find({}).select('_id').lean();
    return courses.map((course) => String(course._id));
  }

  const courses = await Course.find({ instructors: user.userId }).select('_id').lean();
  return courses.map((course) => String(course._id));
}

function getManageableQuestionQuery(user, managedCourseIds = []) {
  if ((user?.roles || []).includes('admin')) {
    return {};
  }

  const clauses = [
    { owner: String(user?.userId || '') },
    { creator: String(user?.userId || '') },
  ];
  if (managedCourseIds.length > 0) {
    clauses.push({ courseId: { $in: managedCourseIds } });
  }
  return { $or: clauses };
}

function chooseEditableQuestion(questions = []) {
  const detachedCopy = questions.find((question) => !question.hasResponses && !question.sessionLinked && String(question?.questionManager?.detachedFromQuestionId || '').trim());
  if (detachedCopy) return detachedCopy;

  return questions.find((question) => !question.hasResponses && !question.sessionLinked) || null;
}

function chooseRepresentativeQuestion(questions = []) {
  return [...questions].sort((left, right) => {
    const leftDetached = String(left?.questionManager?.detachedFromQuestionId || '').trim() ? 1 : 0;
    const rightDetached = String(right?.questionManager?.detachedFromQuestionId || '').trim() ? 1 : 0;
    if (leftDetached !== rightDetached) return rightDetached - leftDetached;
    return getTimestamp(right.lastEditedAt || right.createdAt) - getTimestamp(left.lastEditedAt || left.createdAt);
  })[0] || null;
}

function buildManagerSearchText(entry = {}) {
  return [
    entry.question?.plainText,
    ...(entry.question?.options || []).map((option) => option?.plainText || option?.answer || ''),
    entry.question?.solution_plainText,
    ...entry.tags.map((tag) => tag.label || tag.value || ''),
    ...entry.creators.map((person) => `${person.displayName} ${person.email}`),
    ...entry.owners.map((person) => `${person.displayName} ${person.email}`),
    ...entry.courses.map((course) => course.label),
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function sortEntries(entries = []) {
  return [...entries].sort((left, right) => {
    const byEditedAt = getTimestamp(right.lastEditedAt) - getTimestamp(left.lastEditedAt);
    if (byEditedAt !== 0) return byEditedAt;
    return String(left?.question?.plainText || '').localeCompare(String(right?.question?.plainText || ''));
  });
}

async function buildQuestionManagerEntries({
  questions,
  linkedSessionIdsByQuestionId,
}) {
  const questionIds = questions.map((question) => String(question._id));
  const [responseBackedQuestionIds, users, courses] = await Promise.all([
    Response.distinct('questionId', { questionId: { $in: questionIds } }),
    User.find({
      _id: {
        $in: [...new Set(
          questions.flatMap((question) => [
            String(question?.creator || '').trim(),
            String(question?.owner || '').trim(),
          ]).filter(Boolean)
        )],
      },
    }).select('_id emails profile.firstname profile.lastname').lean(),
    Course.find({
      _id: {
        $in: [...new Set(questions.map((question) => String(question?.courseId || '').trim()).filter(Boolean))],
      },
    }).select('_id name deptCode courseNumber section semester').lean(),
  ]);

  const responseBackedSet = new Set(responseBackedQuestionIds.map((questionId) => String(questionId)));
  const userById = new Map(users.map((user) => [String(user._id), user]));
  const courseById = new Map(courses.map((course) => [String(course._id), course]));
  const groups = new Map();

  questions.forEach((question) => {
    const fingerprint = String(question?.questionManager?.fingerprint || '').trim()
      || buildQuestionManagerFingerprint(question);
    const questionId = String(question._id);
    const sessionLinked = isQuestionSessionLinked(question, linkedSessionIdsByQuestionId);
    const enrichedQuestion = {
      ...question,
      questionManager: {
        ...question.questionManager,
        fingerprint,
      },
      hasResponses: responseBackedSet.has(questionId),
      sessionLinked,
    };

    if (!groups.has(fingerprint)) {
      groups.set(fingerprint, []);
    }
    groups.get(fingerprint).push(enrichedQuestion);
  });

  const entries = [...groups.entries()].map(([fingerprint, groupedQuestions]) => {
    const representativeQuestion = chooseRepresentativeQuestion(groupedQuestions);
    const editableQuestion = chooseEditableQuestion(groupedQuestions);
    const courseCounts = new Map();
    const creatorCounts = new Map();
    const ownerCounts = new Map();
    const tagMap = new Map();

    groupedQuestions.forEach((question) => {
      const courseId = String(question?.courseId || '').trim();
      if (courseId && courseById.has(courseId)) {
        courseCounts.set(courseId, (courseCounts.get(courseId) || 0) + 1);
      }

      const creatorId = String(question?.creator || '').trim();
      if (creatorId) {
        creatorCounts.set(creatorId, (creatorCounts.get(creatorId) || 0) + 1);
      }

      const ownerId = String(question?.owner || '').trim();
      if (ownerId) {
        ownerCounts.set(ownerId, (ownerCounts.get(ownerId) || 0) + 1);
      }

      (question?.tags || []).forEach((tag) => {
        const value = String(tag?.value || tag?.label || '').trim();
        const label = String(tag?.label || tag?.value || '').trim();
        if (!value || !label) return;
        if (!tagMap.has(value.toLowerCase())) {
          tagMap.set(value.toLowerCase(), { value, label, count: 0 });
        }
        tagMap.get(value.toLowerCase()).count += 1;
      });
    });

    const coursesList = [...courseCounts.entries()]
      .map(([courseId, count]) => ({
        _id: courseId,
        label: buildCourseLabel(courseById.get(courseId)),
        count,
      }))
      .sort((left, right) => left.label.localeCompare(right.label));

    const creatorsList = [...creatorCounts.entries()]
      .map(([userId, count]) => buildUserSummary(userById.get(userId), count))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));

    const ownersList = [...ownerCounts.entries()]
      .map(([userId, count]) => buildUserSummary(userById.get(userId), count))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));

    return {
      fingerprint,
      duplicateCount: groupedQuestions.length,
      responseBackedCount: groupedQuestions.filter((question) => question.hasResponses).length,
      deletableQuestionIds: groupedQuestions
        .filter((question) => !question.hasResponses)
        .map((question) => String(question._id || '').trim())
        .filter(Boolean),
      sessionLinkedCount: groupedQuestions.filter((question) => question.sessionLinked).length,
      standaloneCount: groupedQuestions.filter((question) => !String(question?.courseId || '').trim()).length,
      question: representativeQuestion,
      sourceQuestionId: String(representativeQuestion?._id || '').trim(),
      editableQuestionId: String(editableQuestion?._id || '').trim(),
      requiresDetachedCopy: !editableQuestion,
      courses: coursesList,
      creators: creatorsList,
      owners: ownersList,
      tags: [...tagMap.values()].sort((left, right) => left.label.localeCompare(right.label)),
      lastEditedAt: representativeQuestion?.lastEditedAt || representativeQuestion?.createdAt || null,
    };
  });

  return sortEntries(entries);
}

function filterQuestionManagerEntries(entries = [], query = {}) {
  const searchQuery = String(query.q || '').trim().toLowerCase();
  const tagFilters = parseDelimitedValues(query.tags).map((value) => value.toLowerCase());
  const courseId = String(query.courseId || '').trim();
  const creatorId = String(query.creatorId || '').trim();
  const ownerId = String(query.ownerId || '').trim();
  const standalone = String(query.standalone || 'all');
  const duplicates = String(query.duplicates || 'all');

  return entries.filter((entry) => {
    if (searchQuery && !buildManagerSearchText(entry).includes(searchQuery)) {
      return false;
    }

    if (tagFilters.length > 0) {
      const entryTagValues = new Set(entry.tags.map((tag) => String(tag.value || '').trim().toLowerCase()));
      if (!tagFilters.every((value) => entryTagValues.has(value))) {
        return false;
      }
    }

    if (courseId && !entry.courses.some((course) => String(course._id) === courseId)) {
      return false;
    }

    if (creatorId && !entry.creators.some((creator) => String(creator.userId) === creatorId)) {
      return false;
    }

    if (ownerId && !entry.owners.some((owner) => String(owner.userId) === ownerId)) {
      return false;
    }

    if (standalone === 'standalone' && entry.standaloneCount === 0) {
      return false;
    }
    if (standalone === 'course' && entry.courses.length === 0) {
      return false;
    }

    if (duplicates === 'duplicates' && entry.duplicateCount < 2) {
      return false;
    }

    return true;
  });
}

function buildFilterOptions(entries = []) {
  const tags = new Map();
  const courses = new Map();
  const creators = new Map();
  const owners = new Map();

  entries.forEach((entry) => {
    entry.tags.forEach((tag) => {
      const key = String(tag.value || '').trim().toLowerCase();
      if (!key) return;
      if (!tags.has(key)) {
        tags.set(key, { value: tag.value, label: tag.label, count: 0 });
      }
      tags.get(key).count += tag.count || 1;
    });

    entry.courses.forEach((course) => {
      if (!courses.has(course._id)) {
        courses.set(course._id, { ...course });
      }
    });

    entry.creators.forEach((creator) => {
      if (!creators.has(creator.userId)) {
        creators.set(creator.userId, { ...creator });
      }
    });

    entry.owners.forEach((owner) => {
      if (!owners.has(owner.userId)) {
        owners.set(owner.userId, { ...owner });
      }
    });
  });

  return {
    tags: [...tags.values()].sort((left, right) => left.label.localeCompare(right.label)),
    courses: [...courses.values()].sort((left, right) => left.label.localeCompare(right.label)),
    creators: [...creators.values()].sort((left, right) => left.displayName.localeCompare(right.displayName)),
    owners: [...owners.values()].sort((left, right) => left.displayName.localeCompare(right.displayName)),
  };
}

async function getManagerQuestionsForUser(user) {
  const managedCourseIds = await getManagedCourseIdsForUser(user);
  const questions = await Question.find(getManageableQuestionQuery(user, managedCourseIds))
    .select([
      '_id',
      'type',
      'content',
      'plainText',
      'options',
      'correctNumerical',
      'toleranceNumerical',
      'creator',
      'owner',
      'sessionId',
      'courseId',
      'originalQuestion',
      'originalCourse',
      'solution',
      'solution_plainText',
      'createdAt',
      'lastEditedAt',
      'approved',
      'tags',
      'public',
      'publicOnQlicker',
      'publicOnQlickerForStudents',
      'questionManager',
    ].join(' '))
    .lean();

  const questionIds = questions.map((question) => String(question._id));
  const directSessionIds = [...new Set(questions.map((question) => String(question?.sessionId || '').trim()).filter(Boolean))];
  const linkedSessions = questionIds.length > 0
    ? await Session.find({
      $or: [
        { _id: { $in: directSessionIds } },
        { questions: { $in: questionIds } },
      ],
    }).select('_id questions').lean()
    : [];

  const linkedSessionIdsByQuestionId = new Map();
  linkedSessions.forEach((session) => {
    (session.questions || []).forEach((questionId) => {
      const normalizedQuestionId = String(questionId || '').trim();
      if (!normalizedQuestionId) return;
      linkedSessionIdsByQuestionId.set(
        normalizedQuestionId,
        (linkedSessionIdsByQuestionId.get(normalizedQuestionId) || 0) + 1
      );
    });
  });

  questions.forEach((question) => {
    const normalizedQuestionId = String(question?._id || '').trim();
    const directSessionId = String(question?.sessionId || '').trim();
    if (normalizedQuestionId && directSessionId) {
      linkedSessionIdsByQuestionId.set(
        normalizedQuestionId,
        Math.max(1, linkedSessionIdsByQuestionId.get(normalizedQuestionId) || 0)
      );
    }
  });

  return buildQuestionManagerEntries({
    questions,
    linkedSessionIdsByQuestionId,
  });
}

async function getAllowedQuestionManagerQuestionIds(user) {
  const entries = await getManagerQuestionsForUser(user);
  return new Set(
    entries.flatMap((entry) => [entry.sourceQuestionId, entry.editableQuestionId]).filter(Boolean)
  );
}

export default async function questionManagerRoutes(app) {
  const { requireRole } = app;

  app.get(
    '/question-manager/questions',
    {
      preHandler: requireRole(['professor', 'admin']),
      schema: QUESTION_MANAGER_LIST_SCHEMA,
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request) => {
      const page = Math.max(Number(request.query.page) || 1, 1);
      const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 100);
      const showAll = request.query.all === true;
      const allEntries = await getManagerQuestionsForUser(request.user);
      const filteredEntries = filterQuestionManagerEntries(allEntries, request.query);
      const startIndex = (page - 1) * limit;
      const pagedEntries = showAll
        ? filteredEntries
        : filteredEntries.slice(startIndex, startIndex + limit);

      return {
        entries: pagedEntries,
        total: filteredEntries.length,
        page: showAll ? 1 : page,
        limit: showAll ? filteredEntries.length : limit,
        showingAll: showAll,
        filters: buildFilterOptions(allEntries),
      };
    }
  );

  app.post(
    '/question-manager/questions/:id/editable-copy',
    {
      preHandler: requireRole(['professor', 'admin']),
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const question = await Question.findById(request.params.id);
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }

      const entries = await getManagerQuestionsForUser(request.user);
      const entry = entries.find((candidate) => String(candidate.sourceQuestionId) === String(question._id));
      if (!entry) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      if (entry.editableQuestionId) {
        const editableQuestion = await Question.findById(entry.editableQuestionId);
        if (editableQuestion) {
          return {
            question: editableQuestion.toObject(),
            detached: String(editableQuestion._id) !== String(question._id),
          };
        }
      }

      const fingerprint = String(question?.questionManager?.fingerprint || '').trim()
        || buildQuestionManagerFingerprint(question.toObject());
      const existingDetachedCopy = await Question.findOne({
        owner: String(request.user.userId),
        sessionId: '',
        'questionManager.detachedFromQuestionId': String(question._id),
        'questionManager.fingerprint': fingerprint,
      });
      if (existingDetachedCopy) {
        return {
          question: existingDetachedCopy.toObject(),
          detached: true,
        };
      }

      const detachedCopy = await Question.create(buildDetachedQuestionManagerCopyPayload({
        sourceQuestion: question,
        userId: request.user.userId,
      }));

      await notifyQuestionManagerChanged(app, { questions: [detachedCopy] });

      return reply.code(201).send({
        question: detachedCopy.toObject(),
        detached: true,
      });
    }
  );

  app.post(
    '/question-manager/questions/assign-courses',
    {
      preHandler: requireRole(['professor', 'admin']),
      schema: ASSIGN_COURSES_SCHEMA,
      config: {
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const questionIds = [...new Set(request.body.questionIds.map((questionId) => String(questionId || '').trim()).filter(Boolean))];
      const targetCourseIds = [...new Set(request.body.courseIds.map((courseId) => String(courseId || '').trim()).filter(Boolean))];

      const [questions, allowedQuestionIds, managedCourseIds] = await Promise.all([
        Question.find({ _id: { $in: questionIds } }),
        getAllowedQuestionManagerQuestionIds(request.user),
        getManagedCourseIdsForUser(request.user),
      ]);

      if (questions.length !== questionIds.length) {
        return reply.code(404).send({ error: 'Not Found', message: 'One or more questions were not found' });
      }

      if (questionIds.some((questionId) => !allowedQuestionIds.has(questionId))) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const targetCourses = await Course.find({ _id: { $in: targetCourseIds } })
        .select('_id name deptCode courseNumber section semester instructors')
        .lean();
      if (targetCourses.length !== targetCourseIds.length) {
        return reply.code(404).send({ error: 'Not Found', message: 'One or more courses were not found' });
      }

      if (targetCourseIds.some((courseId) => !managedCourseIds.includes(courseId))) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const createdQuestions = [];
      const skippedAssignments = [];
      for (const question of questions) {
        const fingerprint = String(question?.questionManager?.fingerprint || '').trim()
          || buildQuestionManagerFingerprint(question.toObject?.() || question);

        for (const courseId of targetCourseIds) {
          // eslint-disable-next-line no-await-in-loop
          const existingCourseCopy = await Question.findOne({
            courseId,
            sessionId: '',
            'questionManager.fingerprint': fingerprint,
          }).select('_id').lean();

          if (existingCourseCopy) {
            skippedAssignments.push({
              questionId: String(question._id),
              courseId,
              reason: 'already-associated',
            });
            continue;
          }

          // eslint-disable-next-line no-await-in-loop
          const copiedQuestion = await copyQuestionToLibrary({
            sourceQuestion: question,
            targetCourseId: courseId,
            userId: request.user.userId,
          });
          createdQuestions.push(copiedQuestion);
        }
      }

      if (createdQuestions.length > 0) {
        await notifyQuestionManagerChanged(app, { questions: createdQuestions });
      }

      return {
        createdCount: createdQuestions.length,
        skippedCount: skippedAssignments.length,
        createdQuestions: createdQuestions.map((question) => question.toObject()),
        skippedAssignments,
      };
    }
  );

  app.post(
    '/question-manager/questions/import-latex',
    {
      preHandler: requireRole(['professor', 'admin']),
      schema: {
        consumes: ['multipart/form-data'],
      },
      config: {
        rateLimit: { max: 10, timeWindow: '10 minutes' },
      },
    },
    async (request, reply) => {
      let uploadedFile = null;
      let uploadedFilename = '';
      let ignorePoints = false;
      let importTags = [];

      for await (const part of request.parts()) {
        if (part.type === 'file') {
          uploadedFile = await part.toBuffer();
          uploadedFilename = part.filename || 'questions.tex';
          continue;
        }

        if (part.fieldname === 'ignorePoints') {
          ignorePoints = String(part.value || '').trim().toLowerCase() === 'true';
        }
        if (part.fieldname === 'tags') {
          try {
            const parsed = JSON.parse(String(part.value || '[]'));
            importTags = Array.isArray(parsed) ? parsed : [];
          } catch {
            importTags = parseDelimitedValues(part.value);
          }
        }
      }

      if (!uploadedFile) {
        return reply.code(400).send({ error: 'Bad Request', message: 'No LaTeX file uploaded' });
      }

      const source = uploadedFile.toString('utf8');
      const { questions, warnings } = await parseLatexQuestionSet(source, {
        app,
        userId: request.user.userId,
        importTags,
        importFilename: uploadedFilename,
        importIgnoredPoints: ignorePoints,
      });

      if (questions.length === 0) {
        return reply.code(400).send({ error: 'Bad Request', message: 'No importable questions were found in the LaTeX file' });
      }

      const importedQuestions = await Question.insertMany(questions);
      await notifyQuestionManagerChanged(app, { questions: importedQuestions });

      return reply.code(201).send({
        questions: importedQuestions.map((question) => question.toObject()),
        warnings,
      });
    }
  );

  app.post(
    '/question-manager/questions/export-latex',
    {
      preHandler: requireRole(['professor', 'admin']),
      schema: EXPORT_LATEX_SCHEMA,
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const questionIds = [...new Set(request.body.questionIds.map((questionId) => String(questionId)))];
      const questions = await Question.find({ _id: { $in: questionIds } }).lean();
      if (questions.length !== questionIds.length) {
        return reply.code(404).send({ error: 'Not Found', message: 'One or more questions were not found' });
      }

      const allowedQuestionIds = await getAllowedQuestionManagerQuestionIds(request.user);
      if (questionIds.some((questionId) => !allowedQuestionIds.has(questionId))) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const archive = await exportQuestionsToLatexArchive(questions, {
        app,
        includePoints: request.body.includePoints !== false,
      });

      reply.header('Content-Disposition', `attachment; filename="${archive.filename}"`);
      return reply.type(archive.contentType).send(archive.buffer);
    }
  );
}
