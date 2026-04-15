import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import Image from '../models/Image.js';
import { mergeNormalizedTags, normalizeTags } from './questionImportExport.js';
import {
  applyQuestionManagerFingerprint,
  buildQuestionManagerImportMetadata,
} from './questionManager.js';

const execFile = promisify(execFileCallback);

const TIKZ_BLOCK_REGEX = /\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/g;
const ALIGN_BLOCK_REGEX = /\\begin\{align\*?\}[\s\S]*?\\end\{align\*?\}/g;
const ATTACHMENT_FIGURE_REGEX = /\\includegraphics(?:\[[^\]]*\])?\{[^}]+\}|\\capfig(?:\{[^}]*\}){3}|\\rwcapfig(?:\[[^\]]*\])?(?:\{[^}]*\}){3}/g;
const FIGURE_MARKER_REGEX = /__QUESTION_MANAGER_FIGURE_\d+__|\\includegraphics(?:\[[^\]]*\])?\{[^}]+\}|\\capfig(?:\{[^}]*\}){3}|\\rwcapfig(?:\[[^\]]*\])?(?:\{[^}]*\}){3}|\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/g;
const FIGURE_REF_REGEX = /\\(?:auto)?ref\{([^}]+)\}/g;
const FIGURE_LABEL_REGEX = /\\label\{([^}]+)\}/g;
const HTML_ENTITY_MAP = new Map([
  ['&nbsp;', ' '],
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
]);

const EXPORT_PREAMBLE = `%\\documentclass[12pt,answers, oneside, addpoints]{exam}
\\documentclass[12pt, oneside, addpoints]{exam}

\\usepackage[paper=letterpaper, lmargin=0.8in,rmargin=1in,tmargin=1in, bmargin=1in]{geometry}
\\usepackage{paralist}
\\usepackage{parskip}
\\usepackage{calc}
%\\usepackage{subfig}
\\usepackage{setspace}
\\usepackage{amssymb}
\\usepackage{amsmath}
\\usepackage{amstext}
\\usepackage[font={small,it}]{caption}
\\usepackage[pdftex]{graphicx}
\\usepackage{lastpage}
\\usepackage{wrapfig}
\\usepackage{minibox}
\\usepackage{caption}
\\usepackage{tikz}
%\\usepackage{subfig}
\\usepackage{subcaption}
\\usepackage{pgfplots}%for 3d plotting
%for drawing circuits:
\\usepackage[american,smartlabels]{circuitikz}%for drawing circuits
\\usepackage[separate-uncertainty = true]{siunitx}
\\usetikzlibrary{arrows}
\\usetikzlibrary {3d}
\\usetikzlibrary{decorations.markings, math}
\\usetikzlibrary{intersections,pgfplots.fillbetween}
\\usetikzlibrary {shapes.geometric}

\\usetikzlibrary{shapes,arrows}


%Use this to include figures
\\newenvironment{capfig}[3]{\\begin{center}\\includegraphics[width=#1]{#2}\\captionof{figure}{#3}\\end{center}}{}
%Example usage: \\capfig{0.3\\textwdith}{figures/fig1}{the caption of the figure}

\\newenvironment{rwcapfig}[4][0]{
\\begingroup
\\setlength{\\columnsep}{10pt}%
\\begin{wrapfigure}[#1]{r}{#2}\\centering\\includegraphics[width=#2]{#3}\\caption{#4}\\end{wrapfigure}}{\\endgroup}
%%%%

%Shortcuts:
\\newcommand{\\degree}{^{\\circ}}
\\newcommand{\\die}[2]{\\frac{\\partial #1}{\\partial #2}}


%list number of pages
\\cfoot{\\thepage\\ of \\pageref{LastPage}}

%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
%%%%%%
%%%%%% Begin the document
%%%%%%
%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
\\begin{document}
\\begin{center}
\\Large
\\textbf{Questions from the course}
\\end{center}



%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
%
%    Questions
%
%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
\\begin{questions}
`;

const TIKZ_RENDER_PREAMBLE = `\\documentclass[12pt]{article}
\\usepackage[paper=letterpaper, margin=0.3in]{geometry}
\\pagestyle{empty}
\\usepackage{amssymb}
\\usepackage{amsmath}
\\usepackage{amstext}
\\usepackage[pdftex]{graphicx}
\\usepackage{wrapfig}
\\usepackage{minibox}
\\usepackage{caption}
\\usepackage{tikz}
\\usepackage{subcaption}
\\usepackage{pgfplots}
\\usepackage[american,smartlabels]{circuitikz}
\\usepackage[separate-uncertainty = true]{siunitx}
\\usetikzlibrary{arrows}
\\usetikzlibrary {3d}
\\usetikzlibrary{decorations.markings, math}
\\usetikzlibrary{intersections,pgfplots.fillbetween}
\\usetikzlibrary {shapes.geometric}
\\usetikzlibrary{shapes,arrows}
\\begin{document}
`;

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripLatexComments(source) {
  return String(source || '')
    .split('\n')
    .map((line) => {
      let result = '';
      let escaped = false;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === '%' && !escaped) break;
        result += char;
        escaped = char === '\\' && !escaped;
        if (char !== '\\') escaped = false;
      }
      return result;
    })
    .join('\n');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeHtmlEntities(value) {
  let nextValue = String(value || '');
  HTML_ENTITY_MAP.forEach((replacement, entity) => {
    nextValue = nextValue.split(entity).join(replacement);
  });
  return nextValue;
}

function stripHtmlForLatex(html, fallback = '') {
  const source = String(html || '').trim();
  if (!source) return String(fallback || '').trim();

  return decodeHtmlEntities(
    source
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<img[^>]*>/gi, '\n% Figure omitted during export\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function wrapAlignBlocksForKatex(source) {
  return String(source || '').replace(ALIGN_BLOCK_REGEX, (match) => `$$\n${match.trim()}\n$$`);
}

function readBalancedGroup(source, startIndex) {
  if (source[startIndex] !== '{') return null;

  let depth = 0;
  let content = '';
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      if (depth > 0) content += char;
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          content,
          endIndex: index + 1,
        };
      }
      if (depth < 0) return null;
      content += char;
      continue;
    }
    content += char;
  }

  return null;
}

function replaceLatexCommandGroup(source, prefix, replacement = '') {
  const input = String(source || '');
  let result = '';

  for (let index = 0; index < input.length; index += 1) {
    if (!input.startsWith(prefix, index)) {
      result += input[index];
      continue;
    }

    let cursor = index + prefix.length;
    while (cursor < input.length && /\s/.test(input[cursor])) {
      cursor += 1;
    }

    const group = readBalancedGroup(input, cursor);
    if (!group) {
      result += input[index];
      continue;
    }

    if (replacement === '__UNWRAP__') {
      result += group.content;
    } else {
      result += replacement;
    }
    index = group.endIndex - 1;
  }

  return result;
}

function buildFigureReferenceContext(source) {
  const nextSource = stripLatexComments(source || '');
  const markers = [...String(nextSource).matchAll(FIGURE_MARKER_REGEX)].map((match, index) => ({
    index: Number(match.index || 0),
    number: index + 1,
  }));

  if (markers.length === 0) {
    return {
      figureCount: 0,
      labelToNumber: new Map(),
    };
  }

  const labelToNumber = new Map();
  [...String(nextSource).matchAll(FIGURE_LABEL_REGEX)].forEach((match) => {
    const label = String(match[1] || '').trim();
    if (!label) return;

    const labelIndex = Number(match.index || 0);
    const previousMarker = [...markers].reverse().find((marker) => marker.index <= labelIndex);
    const nextMarker = markers.find((marker) => marker.index > labelIndex);
    const targetMarker = previousMarker || nextMarker;
    if (!targetMarker || labelToNumber.has(label)) return;
    labelToNumber.set(label, targetMarker.number);
  });

  const unassignedFigureNumbers = markers
    .map((marker) => marker.number)
    .filter((number) => ![...labelToNumber.values()].includes(number));

  [...String(nextSource).matchAll(FIGURE_REF_REGEX)].forEach((match) => {
    const label = String(match[1] || '').trim();
    if (!label || labelToNumber.has(label) || unassignedFigureNumbers.length === 0) return;
    labelToNumber.set(label, unassignedFigureNumbers.shift());
  });

  return {
    figureCount: markers.length,
    labelToNumber,
  };
}

function resolveFigureReference(label, referenceContext) {
  const normalizedLabel = String(label || '').trim();
  if (!normalizedLabel) return null;
  const explicitFigureNumber = referenceContext?.labelToNumber?.get(normalizedLabel);
  if (Number.isFinite(explicitFigureNumber) && explicitFigureNumber > 0) {
    return explicitFigureNumber;
  }
  if (Number(referenceContext?.figureCount || 0) === 1) {
    return 1;
  }
  return null;
}

export function sanitizeLatexFigureMarkup(source, { referenceContext = null } = {}) {
  let nextSource = String(source || '');
  const resolvedReferenceContext = referenceContext || buildFigureReferenceContext(nextSource);

  nextSource = nextSource
    .replace(/\bFig(?:ure)?\.?\s*~?\s*\\(?:auto)?ref\{([^}]+)\}/gi, (_match, label) => {
      const figureNumber = resolveFigureReference(label, resolvedReferenceContext);
      return figureNumber ? `Figure ${figureNumber}` : 'Figure ?';
    })
    .replace(/\\autoref\{([^}]+)\}/g, (_match, label) => {
      const figureNumber = resolveFigureReference(label, resolvedReferenceContext);
      return figureNumber ? `Figure ${figureNumber}` : 'Figure ?';
    })
    .replace(/~?\\ref\{([^}]+)\}/g, (match, label) => {
      const figureNumber = resolveFigureReference(label, resolvedReferenceContext);
      if (figureNumber) {
        return match.startsWith('~') ? ` ${figureNumber}` : String(figureNumber);
      }
      return match.startsWith('~') ? ' ?' : '?';
    })
    .replace(/\\begin\{center\}/g, '')
    .replace(/\\end\{center\}/g, '')
    .replace(/\\begin\{figure\*?\}(?:\[[^\]]*\])?/g, '')
    .replace(/\\end\{figure\*?\}/g, '')
    .replace(/\\begin\{wrapfigure\}(?:\[[^\]]*\])?(?:\{[^}]*\}){2}/g, '')
    .replace(/\\end\{wrapfigure\}/g, '')
    .replace(/\\centering\b/g, '');

  nextSource = replaceLatexCommandGroup(nextSource, '\\captionsetup', '');
  nextSource = replaceLatexCommandGroup(nextSource, '\\label', '');
  nextSource = replaceLatexCommandGroup(nextSource, '\\captionof{figure}', '__UNWRAP__');
  nextSource = replaceLatexCommandGroup(nextSource, '\\caption', '__UNWRAP__');

  return normalizeWhitespace(nextSource);
}

function parseQuestionPointValue(rawValue, ignorePoints) {
  if (ignorePoints) return 1;
  const numeric = Number.parseFloat(String(rawValue || '').replace(/[^0-9.+-]/g, ''));
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return 1;
}

function buildQuestionBlocks(source) {
  const blocks = [];
  const lines = String(source || '').split('\n');
  let currentSection = '';
  let currentQuestion = null;

  lines.forEach((line) => {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\\section\*\{(.+)\}$/);
    if (sectionMatch) {
      currentSection = normalizeWhitespace(sectionMatch[1]);
      return;
    }

    const questionMatch = trimmed.match(/^\\question(?:\[([^\]]+)\])?\s*(.*)$/);
    if (questionMatch) {
      if (currentQuestion) {
        blocks.push(currentQuestion);
      }
      currentQuestion = {
        points: questionMatch[1] || '',
        section: currentSection,
        lines: questionMatch[2] ? [questionMatch[2]] : [],
      };
      return;
    }

    if (currentQuestion) {
      currentQuestion.lines.push(line);
    }
  });

  if (currentQuestion) {
    blocks.push(currentQuestion);
  }

  return blocks;
}

function extractEnvironment(source, environmentName) {
  const expression = new RegExp(`\\\\begin\\{${environmentName}\\}([\\s\\S]*?)\\\\end\\{${environmentName}\\}`);
  const match = String(source || '').match(expression);
  if (!match) {
    return { content: '', remaining: String(source || '') };
  }

  return {
    content: match[1] || '',
    remaining: String(source || '').replace(match[0], '').trim(),
  };
}

function parseChoiceLines(source) {
  const options = [];
  let current = null;

  String(source || '').split('\n').forEach((line) => {
    const trimmed = line.trim();
    const isCorrect = trimmed.startsWith('\\CorrectChoice');
    const isChoice = isCorrect || trimmed.startsWith('\\choice');

    if (isChoice) {
      if (current) {
        options.push(current);
      }
      current = {
        correct: isCorrect,
        source: trimmed.replace(/^\\(?:CorrectChoice|choice)\s*/, ''),
      };
      return;
    }

    if (current) {
      current.source = `${current.source}\n${line}`.trim();
    }
  });

  if (current) {
    options.push(current);
  }

  return options.filter((option) => normalizeWhitespace(option.source).length > 0);
}

function normalizeOptionPlainText(value) {
  return normalizeWhitespace(value).toLowerCase();
}

async function renderTikzToImage({
  tikzSource,
  app,
  userId,
  filenameBase,
}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qlicker-question-latex-'));
  const texPath = path.join(tempDir, 'figure.tex');
  const pdfPath = path.join(tempDir, 'figure.pdf');
  const pngBasePath = path.join(tempDir, 'figure');

  try {
    await fs.writeFile(
      texPath,
      `${TIKZ_RENDER_PREAMBLE}\n${tikzSource.trim()}\n\\end{document}\n`,
      'utf8'
    );

    await execFile('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', 'figure.tex'], {
      cwd: tempDir,
      timeout: 60_000,
    });
    await execFile('pdftocairo', ['-png', '-singlefile', pdfPath, pngBasePath], {
      cwd: tempDir,
      timeout: 30_000,
    });

    const pngBuffer = await fs.readFile(`${pngBasePath}.png`);
    const trimmedBuffer = await sharp(pngBuffer).trim().png().toBuffer();
    const { url, key } = await app.uploadFile(trimmedBuffer, `${filenameBase}.png`, 'image/png');

    const image = await Image.create({
      url,
      key,
      UID: String(userId || ''),
      type: 'image/png',
      size: trimmedBuffer.length,
      createdAt: new Date(),
    });

    return {
      url: image.url,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function convertLatexFragmentToHtml(source, {
  app,
  userId,
  filenameBase,
  warnings,
  warningPrefix,
  referenceContext = null,
}) {
  let nextSource = wrapAlignBlocksForKatex(stripLatexComments(source || ''));

  const attachmentMatches = nextSource.match(ATTACHMENT_FIGURE_REGEX) || [];
  if (attachmentMatches.length > 0) {
    warnings.push(`${warningPrefix}: attached figures were ignored during LaTeX import.`);
    nextSource = nextSource.replace(ATTACHMENT_FIGURE_REGEX, '').trim();
  }

  const figureTokens = [];
  const tikzMatches = [...nextSource.matchAll(TIKZ_BLOCK_REGEX)];
  for (let index = 0; index < tikzMatches.length; index += 1) {
    const match = tikzMatches[index];
    const token = `__QUESTION_MANAGER_FIGURE_${figureTokens.length}__`;
    const rendered = await renderTikzToImage({
      tikzSource: match[0],
      app,
      userId,
      filenameBase: `${filenameBase}-${index + 1}`,
    });
    figureTokens.push({
      token,
      html: `<img src="${escapeHtml(rendered.url)}" alt="" />`,
    });
    nextSource = nextSource.replace(match[0], token);
  }

  nextSource = sanitizeLatexFigureMarkup(nextSource, { referenceContext });

  const paragraphs = normalizeWhitespace(nextSource)
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const html = paragraphs.map((paragraph) => {
    const escapedParagraph = escapeHtml(paragraph).replace(/\n/g, '<br />');
    const withFigures = figureTokens.reduce(
      (content, figure) => content.split(figure.token).join(figure.html),
      escapedParagraph
    );
    return `<p>${withFigures}</p>`;
  }).join('');

  return {
    html,
    plainText: normalizeWhitespace(
      figureTokens.reduce(
        (content, figure) => content.split(figure.token).join(''),
        nextSource
      )
    ),
  };
}

function formatOptionPayload(option, html, plainText) {
  return {
    content: html,
    plainText,
    answer: plainText,
    correct: !!option.correct,
    wysiwyg: true,
  };
}

function buildLatexImportTags(section, extraTags = []) {
  const baseTags = normalizeTags([
    'Imported',
    'LaTeX',
    ...extraTags,
  ]);
  if (!section) return baseTags;
  const normalizedSection = normalizeWhitespace(section);
  if (!normalizedSection) return baseTags;
  return mergeNormalizedTags(baseTags, [{ value: normalizedSection, label: normalizedSection }]);
}

export async function parseLatexQuestionSet(source, {
  app,
  userId,
  importTags = [],
  importFilename = '',
  importIgnoredPoints = false,
} = {}) {
  const questionsBodyMatch = String(source || '').match(/\\begin\{questions\}([\s\S]*?)\\end\{questions\}/);
  if (!questionsBodyMatch) {
    throw new Error('The selected LaTeX file does not contain a questions environment');
  }

  const warnings = [];
  const blocks = buildQuestionBlocks(questionsBodyMatch[1] || '');
  const importedAt = new Date();
  const questions = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const rawBlock = normalizeWhitespace(block.lines.join('\n'));
    if (!rawBlock) continue;
    const referenceContext = buildFigureReferenceContext(rawBlock);

    const {
      content: solutionSource,
      remaining: withoutSolution,
    } = extractEnvironment(rawBlock, 'solution');

    let choiceEnvironment = 'choices';
    let choiceSource = '';
    let stemSource = withoutSolution;
    const checkboxMatch = withoutSolution.match(/\\begin\{checkboxes\}([\s\S]*?)\\end\{checkboxes\}/);
    const choicesMatch = withoutSolution.match(/\\begin\{choices\}([\s\S]*?)\\end\{choices\}/);
    if (checkboxMatch) {
      choiceEnvironment = 'checkboxes';
      choiceSource = checkboxMatch[1] || '';
      stemSource = withoutSolution.replace(checkboxMatch[0], '').trim();
    } else if (choicesMatch) {
      choiceSource = choicesMatch[1] || '';
      stemSource = withoutSolution.replace(choicesMatch[0], '').trim();
    }

    const stem = await convertLatexFragmentToHtml(stemSource, {
      app,
      userId,
      filenameBase: `question-${index + 1}-stem`,
      warnings,
      warningPrefix: `Question ${index + 1}`,
      referenceContext,
    });

    const solution = await convertLatexFragmentToHtml(solutionSource, {
      app,
      userId,
      filenameBase: `question-${index + 1}-solution`,
      warnings,
      warningPrefix: `Question ${index + 1}`,
      referenceContext,
    });

    const options = [];
    const parsedOptions = parseChoiceLines(choiceSource);
    for (let optionIndex = 0; optionIndex < parsedOptions.length; optionIndex += 1) {
      const option = parsedOptions[optionIndex];
      const optionContent = await convertLatexFragmentToHtml(option.source, {
        app,
        userId,
        filenameBase: `question-${index + 1}-option-${optionIndex + 1}`,
        warnings,
        warningPrefix: `Question ${index + 1} option ${optionIndex + 1}`,
        referenceContext,
      });
      options.push(formatOptionPayload(option, optionContent.html, optionContent.plainText));
    }

    let type = 2;
    const correctOptionCount = options.filter((option) => option.correct).length;
    if (options.length > 0) {
      if (choiceEnvironment === 'checkboxes' || correctOptionCount > 1) {
        type = 3;
      } else if (
        options.length === 2
        && normalizeOptionPlainText(options[0].plainText) === 'true'
        && normalizeOptionPlainText(options[1].plainText) === 'false'
      ) {
        type = 1;
      } else {
        type = 0;
      }
    }

    const tags = buildLatexImportTags(block.section, importTags);
    const basePayload = {
      type,
      content: stem.html,
      plainText: stem.plainText,
      options,
      solution: solution.html,
      solution_plainText: solution.plainText,
      sessionOptions: {
        points: parseQuestionPointValue(block.points, importIgnoredPoints),
      },
      public: false,
      publicOnQlicker: false,
      publicOnQlickerForStudents: false,
      approved: true,
      tags,
      creator: String(userId || ''),
      owner: String(userId || ''),
      sessionId: '',
      courseId: '',
      originalQuestion: '',
      originalCourse: '',
      createdAt: importedAt,
      lastEditedAt: importedAt,
      studentCreated: false,
      questionManager: buildQuestionManagerImportMetadata({
        importedAt,
        importedBy: userId,
        importFormat: 'latex',
        importFilename,
        importIgnoredPoints,
      }),
    };

    questions.push(applyQuestionManagerFingerprint(basePayload, basePayload.questionManager));
  }

  return {
    questions,
    warnings,
  };
}

function formatQuestionTypeSection(type) {
  if (type === 0) return 'Multiple Choice';
  if (type === 1) return 'True / False';
  if (type === 2) return 'Short Answer';
  if (type === 3) return 'Multiple Select';
  if (type === 4) return 'Numerical';
  if (type === 6) return 'Slides';
  return 'Questions';
}

function toLatexText(value) {
  return normalizeWhitespace(String(value || ''));
}

function exportQuestionContentToLatex(question = {}) {
  const sourceText = stripHtmlForLatex(question.content, question.plainText);
  return toLatexText(sourceText);
}

function exportQuestionSolutionToLatex(question = {}) {
  const sourceText = stripHtmlForLatex(question.solution, question.solution_plainText);
  return toLatexText(sourceText);
}

function exportQuestionOptionsToLatex(question = {}) {
  return (question.options || []).map((option) => {
    const text = toLatexText(stripHtmlForLatex(option.content, option.plainText || option.answer));
    return {
      text,
      correct: !!option.correct,
    };
  });
}

function buildQuestionLatexBlock(question = {}, includePoints = true) {
  const points = Number(question?.sessionOptions?.points);
  const pointSuffix = includePoints
    ? `[${Number.isFinite(points) && points > 0 ? points : 1}]`
    : '';
  const lines = [
    `\\question${pointSuffix} ${exportQuestionContentToLatex(question)}`.trim(),
  ];

  const normalizedType = Number(question?.type);
  const options = exportQuestionOptionsToLatex(question);
  if (normalizedType === 0 || normalizedType === 1) {
    lines.push('\\begin{choices}');
    options.forEach((option) => {
      lines.push(`${option.correct ? '\\CorrectChoice' : '\\choice'} ${option.text}`.trim());
    });
    lines.push('\\end{choices}');
  } else if (normalizedType === 3) {
    lines.push('\\begin{checkboxes}');
    options.forEach((option) => {
      lines.push(`${option.correct ? '\\CorrectChoice' : '\\choice'} ${option.text}`.trim());
    });
    lines.push('\\end{checkboxes}');
  }

  const solution = exportQuestionSolutionToLatex(question);
  if (solution) {
    lines.push('\\begin{solution}');
    lines.push(solution);
    lines.push('\\end{solution}');
  }

  return lines.join('\n');
}

export function exportQuestionsToLatex(questions = [], {
  includePoints = true,
  title = 'Questions from the course',
} = {}) {
  const groupedQuestions = new Map();
  (questions || []).forEach((question) => {
    const section = formatQuestionTypeSection(Number(question?.type));
    if (!groupedQuestions.has(section)) {
      groupedQuestions.set(section, []);
    }
    groupedQuestions.get(section).push(question);
  });

  const sections = [...groupedQuestions.entries()].map(([sectionTitle, sectionQuestions]) => {
    const blocks = sectionQuestions.map((question) => buildQuestionLatexBlock(question, includePoints));
    return [
      `\\section*{${sectionTitle}}`,
      ...blocks,
    ].join('\n\n');
  }).join('\n\n');

  return EXPORT_PREAMBLE
    .replace('Questions from the course', title)
    + sections
    + '\n\n\\end{questions}\n\\end{document}\n';
}
