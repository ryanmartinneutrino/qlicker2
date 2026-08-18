import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import apiClient from '../../api/client';
import AiGradingForm from './AiGradingForm';
import { QUESTION_TYPES, normalizeQuestionType } from '../questions/constants';

function canManualGrade(question) {
  return ![
    QUESTION_TYPES.MULTIPLE_CHOICE,
    QUESTION_TYPES.TRUE_FALSE,
    QUESTION_TYPES.MULTI_SELECT,
    QUESTION_TYPES.NUMERICAL,
  ].includes(normalizeQuestionType(question));
}

export default function AiGradingModal({
  open,
  onClose,
  courseId,
  sessionId,
  questions,
  needsGradingQuestionIds,
  onStarted,
}) {
  const { t } = useTranslation();
  const [instructions, setInstructions] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [selected, setSelected] = useState([]);
  const [forms, setForms] = useState({});
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [rubricLoaded, setRubricLoaded] = useState(false);
  const initializedRubricRef = useRef(false);
  const manualQuestions = useMemo(() => questions.filter(canManualGrade), [questions]);

  useEffect(() => {
    if (!open) return undefined;
    setActiveId('');
    setForms({});
    setError('');
    setRubricLoaded(false);
    initializedRubricRef.current = false;
    let mounted = true;
    Promise.all([
      apiClient.get(`/ai/courses/${courseId}/grading-instructions`),
      apiClient.get(`/ai/courses/${courseId}/sessions/${sessionId}/ai-grading-rubric`),
    ])
      .then(([instructionResponse, rubricResponse]) => {
        if (!mounted) return;
        const rubric = rubricResponse.data?.rubric;
        const availableInstructions = instructionResponse.data.instructions || [];
        setInstructions(availableInstructions);
        setSelected(rubric?.questionIds?.length
          ? rubric.questionIds.map(String)
          : manualQuestions
            .filter((question) => needsGradingQuestionIds.includes(String(question._id)))
            .map((question) => String(question._id)));
        setForms(rubric?.instructions || {});
        initializedRubricRef.current = true;
        setRubricLoaded(true);
      })
      .catch(() => {
        if (mounted) setError(t('grades.aiGrading.failedLoad'));
      });
    return () => { mounted = false; };
  // A modal opening is the only time this state should be initialized. In
  // particular, do not reinitialize when a checkbox or instruction changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, courseId, sessionId]);

  useEffect(() => {
    if (!open || !rubricLoaded || !initializedRubricRef.current) return undefined;
    const timer = setTimeout(() => {
      apiClient.put(`/ai/courses/${courseId}/sessions/${sessionId}/ai-grading-rubric`, {
        questionIds: selected,
        instructions: forms,
      }).catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [courseId, forms, open, rubricLoaded, selected, sessionId]);

  const saveInstruction = async (instruction) => {
    const { data } = await apiClient.post(`/ai/courses/${courseId}/grading-instructions`, instruction);
    setInstructions((current) => [
      ...current.filter((entry) => entry._id !== data.instruction._id),
      data.instruction,
    ]);
    return data.instruction;
  };

  const deleteInstruction = async (instruction) => {
    await apiClient.delete(`/ai/courses/${courseId}/grading-instructions/${instruction._id}`);
    setInstructions((current) => current.filter((entry) => entry._id !== instruction._id));
    setForms((current) => Object.fromEntries(Object.entries(current).map(([questionId, form]) => (
      form[`${instruction.kind}InstructionId`] === instruction._id
        ? [questionId, { ...form, [`${instruction.kind}InstructionId`]: '', [instruction.kind]: '' }]
        : [questionId, form]
    ))));
  };

  const toggleQuestion = (questionId) => {
    setSelected((current) => (
      current.includes(questionId)
        ? current.filter((id) => id !== questionId)
        : [...current, questionId]
    ));
  };

  const start = async () => {
    setError('');
    const missing = selected.filter((questionId) => (
      !forms[questionId]?.gradingInstructionId || !forms[questionId]?.feedbackInstructionId
    ));
    if (missing.length) {
      setError(t('grades.aiGrading.instructionsRequired'));
      setActiveId(missing[0]);
      return;
    }

    setStarting(true);
    try {
      const prepared = Object.fromEntries(selected.map((questionId) => {
        const form = forms[questionId] || {};
        return [questionId, {
          grading: form.grading || '',
          feedback: form.feedback || '',
          gradingInstructionId: form.gradingInstructionId || '',
          feedbackInstructionId: form.feedbackInstructionId || '',
          regrade: !!form.regrade,
        }];
      }));
      const { data } = await apiClient.post(
        `/ai/courses/${courseId}/sessions/${sessionId}/ai-grading`,
        {
          questionIds: selected,
          instructions: prepared,
          regrade: Object.values(prepared).some((form) => form.regrade),
        }
      );
      onStarted(data.job);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || t('grades.aiGrading.failedStart'));
    } finally {
      setStarting(false);
    }
  };

  const activeQuestion = manualQuestions.find((question) => String(question._id) === activeId);
  const activeQuestionNumber = activeQuestion ? questions.findIndex((question) => question === activeQuestion) + 1 : null;
  const form = activeId ? (forms[activeId] || {}) : null;
  const canStart = selected.length > 0 && selected.every((questionId) => (
    forms[questionId]?.gradingInstructionId && forms[questionId]?.feedbackInstructionId
  ));

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{t('grades.aiGrading.title')}</DialogTitle>
      <DialogContent dividers>
        {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '180px 1fr' }, gap: 2 }}>
          <List dense aria-label={t('grades.aiGrading.questionSelection')} sx={{ borderRight: { sm: 1 }, borderColor: 'divider', maxHeight: 440, overflowY: 'auto' }}>
            {questions.map((question, index) => {
              const id = String(question._id);
              const enabled = canManualGrade(question);
              return (
                <ListItemButton
                  key={id}
                  disabled={!enabled}
                  selected={activeId === id}
                  onClick={() => setActiveId(id)}
                >
                  <Checkbox
                    size="small"
                    checked={selected.includes(id)}
                    disabled={!enabled}
                    inputProps={{ 'aria-label': t('grades.aiGrading.includeQuestion', { question: index + 1 }) }}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      event.stopPropagation();
                      toggleQuestion(id);
                    }}
                  />
                  <ListItemText
                    primary={`Q${index + 1}`}
                    secondary={enabled ? t('grades.aiGrading.clickQuestionToEdit') : t('grades.aiGrading.notEligible')}
                  />
                </ListItemButton>
              );
            })}
          </List>
          {activeQuestion ? (
            <AiGradingForm
              key={activeId}
              questionNumber={activeQuestionNumber}
              value={form}
              instructions={instructions}
              onChange={(value) => setForms((current) => ({ ...current, [activeId]: value }))}
              onSaveInstruction={saveInstruction}
              onDeleteInstruction={deleteInstruction}
            />
          ) : (
            <Box sx={{ display: 'flex', alignItems: 'center', minHeight: 180 }}>
              <Typography color="text.secondary">
                {t('grades.aiGrading.selectQuestionGuidance')}
              </Typography>
            </Box>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="contained" disabled={!canStart || starting} onClick={start}>
          {t('grades.aiGrading.start')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
