import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  ArrowBack as ArrowBackIcon,
  CloudUpload as UploadIcon,
  Close as CloseIcon,
  Download as DownloadIcon,
  Edit as EditIcon,
  OpenInNew as OpenInNewIcon,
  Refresh as RefreshIcon,
  UnfoldLess as CollapseAllIcon,
  UnfoldMore as ExpandAllIcon,
} from '@mui/icons-material';
import apiClient, { getAccessToken } from '../../api/client';
import QuestionDisplay from '../../components/questions/QuestionDisplay';
import QuestionEditor from '../../components/questions/QuestionEditor';
import { getQuestionTypeLabel, normalizeQuestionType, TYPE_COLORS } from '../../components/questions/constants';

const DEFAULT_LIMIT = 20;
const LIMIT_OPTIONS = [10, 20, 50];
const STANDALONE_OPTIONS = ['all', 'standalone', 'course'];
const DUPLICATE_OPTIONS = ['all', 'duplicates'];

function buildWebsocketUrl(token) {
  const encodedToken = encodeURIComponent(token);
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws?token=${encodedToken}`;
}

function downloadTextFile(filename, content, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function getTimestamp(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function toCsv(values = []) {
  return values.map((value) => String(value || '').trim()).filter(Boolean).join(',');
}

function getEntryQuestionId(entry = {}) {
  return String(entry?.editableQuestionId || entry?.sourceQuestionId || '').trim();
}

function summarizePeople(people = []) {
  return people
    .map((person) => String(person?.displayName || person?.email || '').trim())
    .filter(Boolean)
    .join(', ');
}

function formatImportLabel(entry, t) {
  const manager = entry?.question?.questionManager || {};
  const importedAt = manager.importedAt ? new Date(manager.importedAt) : null;
  if (!manager.importFormat && !importedAt) {
    return t('professor.questionManager.notImported', { defaultValue: 'Created in Qlicker' });
  }

  const timestamp = importedAt && !Number.isNaN(importedAt.getTime())
    ? importedAt.toLocaleString()
    : t('common.unknown');
  const source = manager.importFilename || manager.importFormat || t('common.unknown');
  const importedBy = summarizePeople(entry?.owners || []) || t('common.unknown');

  return t('professor.questionManager.importInfo', {
    defaultValue: 'Imported {{source}} by {{user}} on {{date}}',
    source,
    user: importedBy,
    date: timestamp,
  });
}

function formatCompactImportLabel(entry, t) {
  const manager = entry?.question?.questionManager || {};
  if (!manager.importFormat && !manager.importedAt) {
    return t('professor.questionManager.notImported', { defaultValue: 'Created in Qlicker' });
  }

  const source = manager.importFilename || manager.importFormat || t('common.unknown');
  return t('professor.questionManager.importedLabel', {
    defaultValue: 'Imported: {{source}}',
    source,
  });
}

function buildManagerParams(filters) {
  return {
    page: filters.page,
    limit: filters.limit,
    q: filters.q,
    tags: toCsv(filters.tags),
    courseId: filters.courseId,
    creatorId: filters.creatorId,
    ownerId: filters.ownerId,
    standalone: filters.standalone,
    duplicates: filters.duplicates,
  };
}

function QuestionManagerImportDialog({
  open,
  loading,
  selectedFile,
  ignorePoints,
  importTags,
  tagSuggestions,
  onClose,
  onIgnorePointsChange,
  onImportTagsChange,
  onFileChange,
  onConfirm,
}) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onClose={loading ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t('professor.questionManager.importDialogTitle', { defaultValue: 'Import LaTeX questions' })}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            {t('professor.questionManager.importDialogDescription', {
              defaultValue: 'Upload an exam-class LaTeX file to create standalone question-manager questions.',
            })}
          </Typography>

          <Button component="label" variant="outlined" startIcon={<UploadIcon />} disabled={loading}>
            {t('professor.questionManager.chooseLatexFile', { defaultValue: 'Choose LaTeX file' })}
            <input
              hidden
              type="file"
              accept=".tex,text/x-tex,text/plain"
              onChange={(event) => onFileChange(event.target.files?.[0] || null)}
            />
          </Button>

          <TextField
            label={t('professor.questionManager.selectedFile', { defaultValue: 'Selected file' })}
            value={selectedFile?.name || ''}
            InputProps={{ readOnly: true }}
          />

          <FormControlLabel
            control={(
              <Switch
                checked={ignorePoints}
                onChange={(event) => onIgnorePointsChange(event.target.checked)}
              />
            )}
            label={t('professor.questionManager.ignorePoints', { defaultValue: 'Ignore question point values' })}
          />

          <Typography variant="caption" color="text.secondary">
            {t('professor.questionManager.ignorePointsHelp', {
              defaultValue: 'If enabled, imported questions are saved with the default point value instead of the value from the LaTeX file.',
            })}
          </Typography>

          <Autocomplete
            multiple
            freeSolo
            options={tagSuggestions}
            value={importTags}
            onChange={(_event, nextValue) => onImportTagsChange(nextValue)}
            renderInput={(params) => (
              <TextField
                {...params}
                label={t('professor.questionManager.importTags', { defaultValue: 'Tags to apply to all imported questions' })}
                placeholder={t('professor.questionManager.importTagsPlaceholder', { defaultValue: 'Imported, Midterm, Review' })}
              />
            )}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={loading}>{t('common.cancel')}</Button>
        <Button variant="contained" onClick={onConfirm} disabled={loading || !selectedFile}>
          {loading
            ? t('common.loading')
            : t('professor.questionManager.importConfirm', { defaultValue: 'Import questions' })}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function QuestionManagerExportDialog({
  open,
  loading,
  selectedCount,
  includePoints,
  onClose,
  onIncludePointsChange,
  onConfirm,
}) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onClose={loading ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {t('professor.questionManager.exportDialogTitle', {
          count: selectedCount,
          defaultValue: selectedCount === 1 ? 'Export question group' : `Export ${selectedCount} question groups`,
        })}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            {t('professor.questionManager.exportDialogDescription', {
              defaultValue: 'Export the selected question groups as an exam-class LaTeX document.',
            })}
          </Typography>
          <FormControlLabel
            control={(
              <Switch
                checked={includePoints}
                onChange={(event) => onIncludePointsChange(event.target.checked)}
              />
            )}
            label={t('professor.questionManager.includePoints', { defaultValue: 'Include point values in the export' })}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={loading}>{t('common.cancel')}</Button>
        <Button variant="contained" onClick={onConfirm} disabled={loading || selectedCount === 0}>
          {loading
            ? t('common.loading')
            : t('professor.questionManager.exportConfirm', {
              count: selectedCount,
              defaultValue: selectedCount === 1 ? 'Download LaTeX' : `Download ${selectedCount} groups`,
            })}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function QuestionManager() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const requestIdRef = useRef(0);
  const viewportAnchorRef = useRef(null);
  const cardElementsRef = useRef(new Map());
  const inlineQuestionEditorRef = useRef(null);

  const [filters, setFilters] = useState({
    q: '',
    tags: [],
    courseId: '',
    creatorId: '',
    ownerId: '',
    standalone: 'all',
    duplicates: 'all',
    limit: DEFAULT_LIMIT,
    page: 1,
  });
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [filterOptions, setFilterOptions] = useState({
    tags: [],
    courses: [],
    creators: [],
    owners: [],
  });
  const [selectedFingerprints, setSelectedFingerprints] = useState([]);
  const [expandedFingerprints, setExpandedFingerprints] = useState({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [syncTransport, setSyncTransport] = useState('manual');
  const [pendingRefresh, setPendingRefresh] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState(null);
  const [editingBaseline, setEditingBaseline] = useState(null);
  const [editingEntryFingerprint, setEditingEntryFingerprint] = useState('');
  const [creatingQuestion, setCreatingQuestion] = useState(false);
  const [actionBusyKey, setActionBusyKey] = useState('');
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importIgnorePoints, setImportIgnorePoints] = useState(false);
  const [importTags, setImportTags] = useState([]);
  const [exportDialogState, setExportDialogState] = useState({ open: false, fingerprints: [] });
  const [exportIncludePoints, setExportIncludePoints] = useState(true);
  const deferredSearch = useDeferredValue(filters.q);

  const requestParams = useMemo(() => buildManagerParams({
    ...filters,
    q: deferredSearch || filters.q,
  }), [deferredSearch, filters]);

  const loadEntries = useCallback(async ({ silent = false, focusQuestionId = '' } = {}) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (!silent) {
      setLoading(true);
    }

    try {
      const { data } = await apiClient.get('/question-manager/questions', { params: requestParams });
      if (requestId !== requestIdRef.current) return null;

      const nextEntries = Array.isArray(data?.entries) ? data.entries : [];
      setEntries(nextEntries);
      setTotal(Number(data?.total || 0));
      setFilterOptions({
        tags: Array.isArray(data?.filters?.tags) ? data.filters.tags : [],
        courses: Array.isArray(data?.filters?.courses) ? data.filters.courses : [],
        creators: Array.isArray(data?.filters?.creators) ? data.filters.creators : [],
        owners: Array.isArray(data?.filters?.owners) ? data.filters.owners : [],
      });
      setPendingRefresh(false);

      setSelectedFingerprints((current) => current.filter((fingerprint) => (
        nextEntries.some((entry) => entry.fingerprint === fingerprint)
      )));
      setExpandedFingerprints((current) => Object.fromEntries(
        Object.entries(current).filter(([fingerprint]) => (
          nextEntries.some((entry) => entry.fingerprint === fingerprint)
        ))
      ));

      if (focusQuestionId) {
        const focusedEntry = nextEntries.find((entry) => (
          String(entry?.sourceQuestionId) === String(focusQuestionId)
          || String(entry?.editableQuestionId) === String(focusQuestionId)
          || String(entry?.question?._id) === String(focusQuestionId)
        ));
        if (focusedEntry) {
          setExpandedFingerprints((current) => ({
            ...current,
            [focusedEntry.fingerprint]: true,
          }));
        }
      }

      return data;
    } catch (err) {
      if (requestId !== requestIdRef.current) return null;
      setMessage({
        severity: 'error',
        text: err.response?.data?.message || t('professor.questionManager.failedLoad', {
          defaultValue: 'Failed to load the question manager.',
        }),
      });
      return null;
    } finally {
      if (!silent && requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [requestParams, t]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  const editingQuestionId = String(editingQuestion?._id || '');

  useEffect(() => {
    let ws = null;
    let reconnectTimer = null;
    let pollingTimer = null;
    let closed = false;

    const refreshFromSync = (payload = {}) => {
      if (document.visibilityState !== 'visible') return;

      const changedIds = Array.isArray(payload?.questionIds) ? payload.questionIds.map((id) => String(id)) : [];
      const deletedIds = Array.isArray(payload?.deletedQuestionIds) ? payload.deletedQuestionIds.map((id) => String(id)) : [];
      if (editingQuestionId && (changedIds.includes(editingQuestionId) || deletedIds.includes(editingQuestionId))) {
        return;
      }

      if (creatingQuestion || editingQuestionId) {
        setPendingRefresh(true);
        return;
      }

      loadEntries({ silent: true });
    };

    const startPolling = () => {
      if (pollingTimer || closed) return;
      setSyncTransport('polling');
      pollingTimer = setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        if (creatingQuestion || editingQuestionId) return;
        loadEntries({ silent: true });
      }, 10000);
    };

    const stopPolling = () => {
      if (!pollingTimer) return;
      clearInterval(pollingTimer);
      pollingTimer = null;
    };

    const connect = () => {
      if (closed) return;
      const latestToken = getAccessToken();
      if (!latestToken) {
        startPolling();
        return;
      }

      try {
        ws = new WebSocket(buildWebsocketUrl(latestToken));
      } catch {
        startPolling();
        reconnectTimer = setTimeout(connect, 2500);
        return;
      }

      ws.onopen = () => {
        stopPolling();
        setSyncTransport('websocket');
      };

      ws.onmessage = (event) => {
        try {
          const messagePayload = JSON.parse(event.data);
          if (messagePayload?.event === 'question-manager:changed') {
            refreshFromSync(messagePayload.data);
          }
        } catch {
          // Ignore malformed websocket payloads.
        }
      };

      ws.onclose = () => {
        if (closed) return;
        startPolling();
        reconnectTimer = setTimeout(connect, 2500);
      };
    };

    const initializeTransport = async () => {
      try {
        const { data } = await apiClient.get('/health');
        if (data?.websocket === true) {
          connect();
          return;
        }
        startPolling();
      } catch {
        startPolling();
      }
    };

    const handleVisibilityRefresh = () => {
      if (document.visibilityState !== 'visible') return;
      if (creatingQuestion || editingQuestionId) return;
      loadEntries({ silent: true });
    };

    initializeTransport();
    window.addEventListener('focus', handleVisibilityRefresh);
    document.addEventListener('visibilitychange', handleVisibilityRefresh);

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopPolling();
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
      window.removeEventListener('focus', handleVisibilityRefresh);
      document.removeEventListener('visibilitychange', handleVisibilityRefresh);
    };
  }, [creatingQuestion, editingQuestionId, loadEntries]);

  const tagSuggestionLabels = useMemo(() => (
    filterOptions.tags.map((tag) => String(tag?.label || tag?.value || '').trim()).filter(Boolean)
  ), [filterOptions.tags]);

  const selectedCount = selectedFingerprints.length;
  const totalPages = Math.max(Math.ceil(total / Number(filters.limit || DEFAULT_LIMIT)), 1);
  const allEntriesExpanded = entries.length > 0 && entries.every((entry) => (
    editingEntryFingerprint === entry.fingerprint || !!expandedFingerprints[entry.fingerprint]
  ));

  const updateFilter = useCallback((key, value) => {
    setFilters((current) => ({
      ...current,
      [key]: value,
      page: key === 'page' || key === 'limit' ? (key === 'limit' ? 1 : value) : 1,
    }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({
      q: '',
      tags: [],
      courseId: '',
      creatorId: '',
      ownerId: '',
      standalone: 'all',
      duplicates: 'all',
      limit: DEFAULT_LIMIT,
      page: 1,
    });
  }, []);

  const closeEditorPanel = useCallback(async ({ persistedQuestionId = '' } = {}) => {
    if (editingEntryFingerprint) {
      const cardElement = cardElementsRef.current.get(editingEntryFingerprint);
      if (cardElement?.getBoundingClientRect) {
        viewportAnchorRef.current = {
          fingerprint: editingEntryFingerprint,
          top: cardElement.getBoundingClientRect().top,
        };
      }
    }
    setCreatingQuestion(false);
    setEditingQuestion(null);
    setEditingBaseline(null);
    setEditingEntryFingerprint('');
    await loadEntries({ focusQuestionId: persistedQuestionId });
  }, [editingEntryFingerprint, loadEntries]);

  const handleEditorSave = useCallback(async (payload, questionId) => {
    try {
      if (questionId) {
        const { data } = await apiClient.patch(`/questions/${questionId}`, payload);
        setEditingQuestion(data.question);
        return data.question;
      }

      const { data } = await apiClient.post('/questions', payload);
      setEditingQuestion(data.question);
      return data.question;
    } catch (err) {
      setMessage({
        severity: 'error',
        text: err.response?.data?.message || t('professor.questionManager.failedSave', {
          defaultValue: 'Failed to save the question.',
        }),
      });
      throw err;
    }
  }, [t]);

  const handleStartNewQuestion = useCallback(() => {
    setMessage(null);
    setCreatingQuestion(true);
    setEditingQuestion(null);
    setEditingBaseline(null);
    setEditingEntryFingerprint('');
  }, []);

  const requestInlineEditorClose = useCallback(() => {
    const requestClose = inlineQuestionEditorRef.current?.requestClose;
    if (typeof requestClose === 'function') {
      requestClose();
      return;
    }
    closeEditorPanel();
  }, [closeEditorPanel]);

  const handleStartEditingEntry = useCallback(async (entry) => {
    if (!entry?.sourceQuestionId) return;
    const cardElement = cardElementsRef.current.get(entry.fingerprint);
    if (cardElement?.getBoundingClientRect) {
      viewportAnchorRef.current = {
        fingerprint: entry.fingerprint,
        top: cardElement.getBoundingClientRect().top,
      };
    } else {
      viewportAnchorRef.current = null;
    }
    const busyKey = `edit:${entry.fingerprint}`;
    setActionBusyKey(busyKey);
    setMessage(null);

    try {
      const { data } = await apiClient.post(`/question-manager/questions/${entry.sourceQuestionId}/editable-copy`);
      setCreatingQuestion(false);
      setEditingQuestion(data.question);
      setEditingBaseline(data.question);
      setEditingEntryFingerprint(entry.fingerprint);
      setExpandedFingerprints((current) => ({
        ...current,
        [entry.fingerprint]: true,
      }));
      if (data?.detached) {
        setMessage({
          severity: 'info',
          text: t('professor.questionManager.detachedCopyReady', {
            defaultValue: 'Editing will use a detached copy with no session or response data attached.',
          }),
        });
      }
    } catch (err) {
      setMessage({
        severity: 'error',
        text: err.response?.data?.message || t('professor.questionManager.failedCreateEditableCopy', {
          defaultValue: 'Failed to prepare an editable copy of the question.',
        }),
      });
      viewportAnchorRef.current = null;
    } finally {
      setActionBusyKey('');
    }
  }, [t]);

  const handleToggleSelection = useCallback((fingerprint) => {
    const cardElement = cardElementsRef.current.get(fingerprint);
    if (cardElement?.getBoundingClientRect) {
      viewportAnchorRef.current = {
        fingerprint,
        top: cardElement.getBoundingClientRect().top,
      };
    } else {
      viewportAnchorRef.current = null;
    }
    setSelectedFingerprints((current) => (
      current.includes(fingerprint)
        ? current.filter((value) => value !== fingerprint)
        : [...current, fingerprint]
    ));
  }, []);

  const handleOpenExportDialog = useCallback((fingerprints) => {
    setExportDialogState({ open: true, fingerprints });
  }, []);

  const handleExportQuestions = useCallback(async () => {
    const exportEntries = entries.filter((entry) => exportDialogState.fingerprints.includes(entry.fingerprint));
    const questionIds = exportEntries.map(getEntryQuestionId).filter(Boolean);
    if (questionIds.length === 0) return;

    setActionBusyKey('export');
    try {
      const { data } = await apiClient.post('/question-manager/questions/export-latex', {
        questionIds,
        includePoints: exportIncludePoints,
      });
      downloadTextFile(data?.filename || 'question-manager-export.tex', data?.content || '');
      setMessage({
        severity: 'success',
        text: t('professor.questionManager.exported', {
          count: questionIds.length,
          defaultValue: questionIds.length === 1 ? 'Exported 1 question group.' : `Exported ${questionIds.length} question groups.`,
        }),
      });
      setExportDialogState({ open: false, fingerprints: [] });
    } catch (err) {
      setMessage({
        severity: 'error',
        text: err.response?.data?.message || t('professor.questionManager.failedExport', {
          defaultValue: 'Failed to export the selected questions.',
        }),
      });
    } finally {
      setActionBusyKey('');
    }
  }, [entries, exportDialogState.fingerprints, exportIncludePoints, t]);

  const handleImportQuestions = useCallback(async () => {
    if (!importFile) return;

    const formData = new FormData();
    formData.append('file', importFile);
    formData.append('ignorePoints', String(importIgnorePoints));
    formData.append('tags', JSON.stringify(importTags));

    setActionBusyKey('import');
    try {
      const { data } = await apiClient.post('/question-manager/questions/import-latex', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setImportDialogOpen(false);
      setImportFile(null);
      setImportIgnorePoints(false);
      setImportTags([]);
      await loadEntries({ focusQuestionId: data?.questions?.[0]?._id });

      const warnings = Array.isArray(data?.warnings) ? data.warnings.filter(Boolean) : [];
      setMessage({
        severity: warnings.length > 0 ? 'warning' : 'success',
        text: warnings.length > 0
          ? [
            t('professor.questionManager.importedWithWarnings', {
              count: Number(data?.questions?.length || 0),
              defaultValue: Number(data?.questions?.length || 0) === 1
                ? 'Imported 1 question with warnings.'
                : `Imported ${Number(data?.questions?.length || 0)} questions with warnings.`,
            }),
            ...warnings,
          ].join(' ')
          : t('professor.questionManager.imported', {
            count: Number(data?.questions?.length || 0),
            defaultValue: Number(data?.questions?.length || 0) === 1
              ? 'Imported 1 question.'
              : `Imported ${Number(data?.questions?.length || 0)} questions.`,
          }),
      });
    } catch (err) {
      setMessage({
        severity: 'error',
        text: err.response?.data?.message || t('professor.questionManager.failedImport', {
          defaultValue: 'Failed to import LaTeX questions.',
        }),
      });
    } finally {
      setActionBusyKey('');
    }
  }, [importFile, importIgnorePoints, importTags, loadEntries, t]);

  const handleRefreshNow = useCallback(async () => {
    setMessage(null);
    await loadEntries();
  }, [loadEntries]);

  const toggleExpanded = useCallback((fingerprint) => {
    const cardElement = cardElementsRef.current.get(fingerprint);
    if (cardElement?.getBoundingClientRect) {
      viewportAnchorRef.current = {
        fingerprint,
        top: cardElement.getBoundingClientRect().top,
      };
    } else {
      viewportAnchorRef.current = null;
    }

    setExpandedFingerprints((current) => ({
      ...current,
      [fingerprint]: !current[fingerprint],
    }));
  }, []);

  const handleToggleAllExpanded = useCallback(() => {
    if (entries.length === 0) return;
    const nextExpanded = !allEntriesExpanded;
    setExpandedFingerprints(Object.fromEntries(
      entries.map((entry) => [entry.fingerprint, nextExpanded])
    ));
  }, [allEntriesExpanded, entries]);

  useLayoutEffect(() => {
    const anchor = viewportAnchorRef.current;
    if (!anchor) return;

    const element = cardElementsRef.current.get(anchor.fingerprint);
    if (!element?.getBoundingClientRect) {
      viewportAnchorRef.current = null;
      return;
    }

    const nextTop = element.getBoundingClientRect().top;
    const delta = nextTop - anchor.top;
    if (Math.abs(delta) > 1) {
      window.scrollTo({
        left: window.scrollX,
        top: window.scrollY + delta,
      });
    }

    viewportAnchorRef.current = null;
  }, [editingEntryFingerprint, editingQuestion?._id, expandedFingerprints, selectedFingerprints]);

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, display: 'flex', flexDirection: 'column', gap: 2 }}>
      {message ? (
        <Alert severity={message.severity} onClose={() => setMessage(null)}>
          {message.text}
        </Alert>
      ) : null}

      {pendingRefresh ? (
        <Alert severity="info" onClose={() => setPendingRefresh(false)}>
          {t('professor.questionManager.refreshNeeded', {
            defaultValue: 'Question manager data changed while you were editing. Close the editor or refresh when you are ready.',
          })}
        </Alert>
      ) : null}

      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Stack spacing={2}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25} justifyContent="space-between" alignItems={{ xs: 'flex-start', md: 'center' }}>
            <Box>
              <Typography variant="h4">{t('professor.questionManager.title', { defaultValue: 'Question Manager' })}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {t('professor.questionManager.subtitle', {
                  defaultValue: 'Manage reusable questions across courses, independent of session response data.',
                })}
              </Typography>
            </Box>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Chip
                variant="outlined"
                label={syncTransport === 'websocket'
                  ? t('professor.questionManager.syncWebsocket', { defaultValue: 'Live sync: WebSocket' })
                  : syncTransport === 'polling'
                    ? t('professor.questionManager.syncPolling', { defaultValue: 'Live sync: Polling' })
                    : t('professor.questionManager.syncManual', { defaultValue: 'Live sync: Manual' })}
              />
              <Chip
                color="primary"
                label={t('professor.questionManager.summary', {
                  count: total,
                  defaultValue: total === 1 ? '1 matching question group' : `${total} matching question groups`,
                })}
              />
              <Chip
                variant="outlined"
                label={t('professor.questionManager.selectedCount', {
                  count: selectedCount,
                  defaultValue: selectedCount === 1 ? '1 selected' : `${selectedCount} selected`,
                })}
              />
            </Stack>
          </Stack>

          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} flexWrap="wrap" useFlexGap>
            <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/prof')}>
              {t('professor.questionManager.backToDashboard', { defaultValue: 'Back to Dashboard' })}
            </Button>
            <Button variant="contained" startIcon={<AddIcon />} onClick={handleStartNewQuestion}>
              {t('questionLibrary.newQuestion', { defaultValue: 'New question' })}
            </Button>
            <Button variant="outlined" startIcon={<UploadIcon />} onClick={() => setImportDialogOpen(true)}>
              {t('professor.questionManager.importLatex', { defaultValue: 'Import LaTeX' })}
            </Button>
            <Button
              variant="outlined"
              startIcon={<DownloadIcon />}
              disabled={selectedCount === 0}
              onClick={() => handleOpenExportDialog(selectedFingerprints)}
            >
              {t('professor.questionManager.exportLatex', { defaultValue: 'Export LaTeX' })}
            </Button>
            <Button startIcon={<RefreshIcon />} onClick={handleRefreshNow}>
              {t('professor.questionManager.refresh', { defaultValue: 'Refresh' })}
            </Button>
            <Button
              variant="outlined"
              startIcon={allEntriesExpanded ? <CollapseAllIcon /> : <ExpandAllIcon />}
              onClick={handleToggleAllExpanded}
              disabled={entries.length === 0}
            >
              {allEntriesExpanded
                ? t('professor.questionManager.collapseAll', { defaultValue: 'Collapse all' })
                : t('professor.questionManager.expandAll', { defaultValue: 'Expand all' })}
            </Button>
          </Stack>
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25} flexWrap="wrap" useFlexGap>
          <TextField
            sx={{ minWidth: { xs: '100%', md: 280 }, flex: 1 }}
            label={t('common.search')}
            placeholder={t('professor.questionManager.searchPlaceholder', {
              defaultValue: 'Search content, tags, creators, owners, and courses',
            })}
            value={filters.q}
            onChange={(event) => updateFilter('q', event.target.value)}
          />

          <Autocomplete
            multiple
            sx={{ minWidth: { xs: '100%', md: 240 }, flex: 1 }}
            options={filterOptions.tags}
            value={filterOptions.tags.filter((tag) => filters.tags.includes(tag.value))}
            isOptionEqualToValue={(option, value) => option.value === value.value}
            getOptionLabel={(option) => option?.label || option?.value || ''}
            onChange={(_event, nextValue) => updateFilter('tags', nextValue.map((tag) => tag.value))}
            renderInput={(params) => (
              <TextField
                {...params}
                label={t('questionLibrary.filters.tags', { defaultValue: 'Tags' })}
                placeholder={t('questionLibrary.filters.tagsPlaceholder', { defaultValue: 'Filter by tag' })}
              />
            )}
          />

          <Autocomplete
            sx={{ minWidth: { xs: '100%', md: 240 }, flex: 1 }}
            options={filterOptions.courses}
            value={filterOptions.courses.find((course) => String(course._id) === String(filters.courseId)) || null}
            isOptionEqualToValue={(option, value) => option._id === value._id}
            getOptionLabel={(option) => option?.label || ''}
            onChange={(_event, nextValue) => updateFilter('courseId', nextValue?._id || '')}
            renderInput={(params) => (
              <TextField
                {...params}
                label={t('professor.questionManager.courseFilter', { defaultValue: 'Course' })}
              />
            )}
          />

          <Autocomplete
            sx={{ minWidth: { xs: '100%', md: 220 } }}
            options={filterOptions.creators}
            value={filterOptions.creators.find((person) => String(person.userId) === String(filters.creatorId)) || null}
            isOptionEqualToValue={(option, value) => option.userId === value.userId}
            getOptionLabel={(option) => option?.displayName || option?.email || ''}
            onChange={(_event, nextValue) => updateFilter('creatorId', nextValue?.userId || '')}
            renderInput={(params) => (
              <TextField
                {...params}
                label={t('professor.questionManager.creatorFilter', { defaultValue: 'Creator' })}
              />
            )}
          />

          <Autocomplete
            sx={{ minWidth: { xs: '100%', md: 220 } }}
            options={filterOptions.owners}
            value={filterOptions.owners.find((person) => String(person.userId) === String(filters.ownerId)) || null}
            isOptionEqualToValue={(option, value) => option.userId === value.userId}
            getOptionLabel={(option) => option?.displayName || option?.email || ''}
            onChange={(_event, nextValue) => updateFilter('ownerId', nextValue?.userId || '')}
            renderInput={(params) => (
              <TextField
                {...params}
                label={t('professor.questionManager.ownerFilter', { defaultValue: 'Owner' })}
              />
            )}
          />

          <TextField
            select
            sx={{ minWidth: 190 }}
            label={t('professor.questionManager.scopeFilter', { defaultValue: 'Question scope' })}
            value={filters.standalone}
            onChange={(event) => updateFilter('standalone', event.target.value)}
          >
            {STANDALONE_OPTIONS.map((value) => (
              <MenuItem key={value} value={value}>
                {t(`professor.questionManager.scope.${value}`, {
                  defaultValue: value === 'all'
                    ? 'All questions'
                    : value === 'standalone'
                      ? 'Course-independent only'
                      : 'Course-linked only',
                })}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            sx={{ minWidth: 170 }}
            label={t('professor.questionManager.duplicateFilter', { defaultValue: 'Duplicates' })}
            value={filters.duplicates}
            onChange={(event) => updateFilter('duplicates', event.target.value)}
          >
            {DUPLICATE_OPTIONS.map((value) => (
              <MenuItem key={value} value={value}>
                {t(`professor.questionManager.duplicates.${value}`, {
                  defaultValue: value === 'all' ? 'All groups' : 'Duplicates only',
                })}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            sx={{ minWidth: 120 }}
            label={t('questionLibrary.filters.limit', { defaultValue: 'Rows' })}
            value={filters.limit}
            onChange={(event) => updateFilter('limit', Number(event.target.value) || DEFAULT_LIMIT)}
          >
            {LIMIT_OPTIONS.map((value) => (
              <MenuItem key={value} value={value}>{value}</MenuItem>
            ))}
          </TextField>

          <Button onClick={clearFilters}>{t('professor.questionManager.clearFilters', { defaultValue: 'Clear filters' })}</Button>
        </Stack>
      </Paper>

      {loading ? (
        <Box sx={{ py: 8, display: 'flex', justifyContent: 'center' }}>
          <CircularProgress aria-label={t('professor.questionManager.loading', { defaultValue: 'Loading question manager…' })} />
        </Box>
      ) : (
        <Stack spacing={1.5}>
          {creatingQuestion ? (
            <Paper variant="outlined" sx={{ p: 2.25 }}>
              <Stack spacing={2}>
                <Box>
                  <Typography variant="h6">
                    {t('questionLibrary.newQuestion', { defaultValue: 'New question' })}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {t('professor.questionManager.editingNewHelp', {
                      defaultValue: 'New question-manager questions start as standalone questions with no course or session attached.',
                    })}
                  </Typography>
                </Box>

                <QuestionEditor
                  open
                  inline
                  initial={null}
                  initialBaseline={null}
                  onAutoSave={handleEditorSave}
                  onClose={closeEditorPanel}
                  tagSuggestions={tagSuggestionLabels}
                  showVisibilityControls={false}
                  allowCustomTags
                />
              </Stack>
            </Paper>
          ) : null}

          <Stack spacing={1.5}>
            {entries.length === 0 ? (
              <Alert severity="info">
                {t('professor.questionManager.empty', { defaultValue: 'No question groups match the current filters.' })}
              </Alert>
            ) : entries.map((entry, index) => {
              const selected = selectedFingerprints.includes(entry.fingerprint);
              const expanded = !!expandedFingerprints[entry.fingerprint];
              const editing = editingEntryFingerprint === entry.fingerprint && !!editingQuestion;
              const normalizedType = normalizeQuestionType(entry.question);
              const duplicateCount = Number(entry?.duplicateCount || 0);
              const responseBackedCount = Number(entry?.responseBackedCount || 0);
              const sessionLinkedCount = Number(entry?.sessionLinkedCount || 0);
              const standaloneCount = Number(entry?.standaloneCount || 0);
              const importLabel = formatImportLabel(entry, t);
              const compactImportLabel = formatCompactImportLabel(entry, t);
              const singleCourse = entry.courses.length === 1 ? entry.courses[0] : null;
              const coursesLabel = entry.courses.length > 0
                ? entry.courses.map((course) => course.label).join(', ')
                : t('professor.questionManager.courseIndependent', { defaultValue: 'Course-independent' });
              const metadataSummary = [
                `${t('professor.questionManager.coursesLabel', { defaultValue: 'Courses' })}: ${coursesLabel}`,
                `${t('professor.questionManager.creatorLabel', { defaultValue: 'Creator' })}: ${summarizePeople(entry.creators) || t('common.unknown')}`,
                `${t('professor.questionManager.ownerLabel', { defaultValue: 'Owner' })}: ${summarizePeople(entry.owners) || t('common.unknown')}`,
                `${t('professor.questionManager.lastEdited', { defaultValue: 'Last edited' })}: ${getTimestamp(entry.lastEditedAt) > 0
                  ? new Date(entry.lastEditedAt).toLocaleString()
                  : t('common.unknown')}`,
                compactImportLabel,
              ].join(' • ');

              return (
                <Card
                  key={entry.fingerprint}
                  variant="outlined"
                  ref={(node) => {
                    if (node) {
                      cardElementsRef.current.set(entry.fingerprint, node);
                    } else {
                      cardElementsRef.current.delete(entry.fingerprint);
                    }
                  }}
                  sx={{
                    borderColor: editing ? 'primary.main' : expanded ? 'primary.light' : 'divider',
                    boxShadow: editing ? 2 : 'none',
                    overflowAnchor: 'none',
                  }}
                >
                  <CardContent sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
                    <Checkbox
                      checked={selected}
                      onClick={(event) => {
                        event.stopPropagation();
                      }}
                      onChange={() => handleToggleSelection(entry.fingerprint)}
                      inputProps={{
                        'aria-label': t('professor.questionManager.selectQuestionGroup', {
                          defaultValue: `Select question group ${index + 1}`,
                        }),
                      }}
                    />
                    <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'flex-start', md: 'center' }} sx={{ mb: 1 }}>
                        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                          <Chip
                            size="small"
                            color={TYPE_COLORS[normalizedType] || 'default'}
                            label={getQuestionTypeLabel(t, normalizedType, { defaultValue: String(normalizedType) })}
                          />
                          {duplicateCount > 1 ? (
                            <Chip
                              size="small"
                              variant="outlined"
                              label={t('professor.questionManager.duplicateCopies', {
                                count: duplicateCount,
                                defaultValue: duplicateCount === 1 ? '1 copy' : `${duplicateCount} copies`,
                              })}
                            />
                          ) : null}
                          {responseBackedCount > 0 ? (
                            <Chip
                              size="small"
                              color="warning"
                              variant="outlined"
                              label={t('professor.questionManager.responseBackedCopies', {
                                count: responseBackedCount,
                                defaultValue: responseBackedCount === 1 ? '1 copy has responses' : `${responseBackedCount} copies have responses`,
                              })}
                            />
                          ) : null}
                          {sessionLinkedCount > 0 ? (
                            <Chip
                              size="small"
                              variant="outlined"
                              label={t('professor.questionManager.sessionLinkedCopies', {
                                count: sessionLinkedCount,
                                defaultValue: sessionLinkedCount === 1 ? '1 session-linked copy' : `${sessionLinkedCount} session-linked copies`,
                              })}
                            />
                          ) : null}
                          {standaloneCount > 0 ? (
                            <Chip
                              size="small"
                              variant="outlined"
                              label={t('professor.questionManager.standaloneCopies', {
                                count: standaloneCount,
                                defaultValue: standaloneCount === 1 ? '1 course-independent copy' : `${standaloneCount} course-independent copies`,
                              })}
                            />
                          ) : null}
                        </Stack>
                        <Stack direction="row" spacing={0.5}>
                          <Tooltip title={editing
                            ? t('professor.sessionEditor.closeEditor')
                            : entry.requiresDetachedCopy
                              ? t('professor.questionManager.createEditableCopy', { defaultValue: 'Create editable copy' })
                              : t('common.edit')}>
                            <span>
                              <IconButton
                                size="small"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (editing) {
                                    requestInlineEditorClose();
                                    return;
                                  }
                                  handleStartEditingEntry(entry);
                                }}
                                disabled={actionBusyKey === `edit:${entry.fingerprint}`}
                                aria-label={editing
                                  ? t('professor.sessionEditor.closeEditor')
                                  : entry.requiresDetachedCopy
                                    ? t('professor.questionManager.createEditableCopy', { defaultValue: 'Create editable copy' })
                                    : t('common.edit')}
                              >
                                {editing ? <CloseIcon fontSize="small" /> : <EditIcon fontSize="small" />}
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip title={t('professor.questionManager.exportLatex', { defaultValue: 'Export LaTeX' })}>
                            <span>
                              <IconButton
                                size="small"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleOpenExportDialog([entry.fingerprint]);
                                }}
                                aria-label={t('professor.questionManager.exportLatex', { defaultValue: 'Export LaTeX' })}
                              >
                                <DownloadIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Stack>
                      </Stack>

                      {editing ? (
                        <Stack spacing={1.5}>
                          <Box>
                            <Typography variant="subtitle1">
                              {t('professor.questionManager.editingTitle', { defaultValue: 'Editing question' })}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              {t('professor.questionManager.editingExistingHelp', {
                                defaultValue: 'Autosave is on. Changes here update only the editable manager copy.',
                              })}
                            </Typography>
                          </Box>

                          {entry.requiresDetachedCopy ? (
                            <Alert severity="info">
                              {t('professor.questionManager.detachedCopyRequired', {
                                defaultValue: 'This question group includes response-backed or session-linked copies, so editing happens on a detached standalone copy instead.',
                              })}
                            </Alert>
                          ) : null}

                          <QuestionEditor
                            ref={inlineQuestionEditorRef}
                            open
                            inline
                            initial={editingQuestion}
                            initialBaseline={editingBaseline}
                            onAutoSave={handleEditorSave}
                            onClose={closeEditorPanel}
                            tagSuggestions={tagSuggestionLabels}
                            showVisibilityControls={false}
                            allowCustomTags
                          />
                        </Stack>
                      ) : (
                        <Box
                          data-question-manager-preview={entry.fingerprint}
                          role="button"
                          tabIndex={0}
                          aria-expanded={expanded}
                          onClick={() => {
                            toggleExpanded(entry.fingerprint);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              toggleExpanded(entry.fingerprint);
                            }
                          }}
                          sx={{
                            cursor: 'pointer',
                            borderRadius: 1,
                            p: 0.5,
                            '&:hover': { backgroundColor: 'action.hover' },
                          }}
                        >
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                            {t('questionLibrary.previewHint', {
                              number: (filters.page - 1) * filters.limit + index + 1,
                              defaultValue: `Question ${(filters.page - 1) * filters.limit + index + 1}`,
                            })}
                            {' \u00b7 '}
                            {expanded
                              ? t('questionLibrary.tapCollapse', { defaultValue: 'Tap to collapse' })
                              : t('questionLibrary.tapExpand', { defaultValue: 'Tap to expand' })}
                          </Typography>
                          <Box sx={{ position: 'relative', maxHeight: expanded ? 'none' : 220, overflow: 'hidden' }}>
                            <QuestionDisplay question={entry.question} allowVideoEmbeds={false} />
                            {!expanded ? (
                              <Box
                                sx={{
                                  position: 'absolute',
                                  left: 0,
                                  right: 0,
                                  bottom: 0,
                                  height: 52,
                                  background: (theme) => `linear-gradient(to bottom, rgba(255,255,255,0), ${theme.palette.background.paper})`,
                                  pointerEvents: 'none',
                                }}
                              />
                            ) : null}
                          </Box>
                        </Box>
                      )}

                      <Tooltip title={importLabel}>
                        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block', lineHeight: 1.5 }}>
                          {metadataSummary}
                        </Typography>
                      </Tooltip>

                      {singleCourse ? (
                        <Button
                          size="small"
                          startIcon={<OpenInNewIcon />}
                          sx={{ mt: 1 }}
                          onClick={(event) => {
                            event.stopPropagation();
                            navigate(`/prof/course/${singleCourse._id}`);
                          }}
                        >
                          {t('professor.questionManager.openCourse', { defaultValue: 'Open course workspace' })}
                        </Button>
                      ) : null}

                      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                        {entry.tags.map((tag) => (
                          <Chip key={`${entry.fingerprint}-${tag.value}`} size="small" variant="outlined" label={tag.label || tag.value} />
                        ))}
                      </Stack>
                    </Box>
                  </CardContent>
                </Card>
              );
            })}

            {entries.length > 0 ? (
              <Paper variant="outlined" sx={{ p: 1.5 }}>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'flex-start', md: 'center' }}>
                  <Typography variant="body2" color="text.secondary">
                    {t('questionLibrary.pagination.summary', {
                      page: filters.page,
                      pages: totalPages,
                      defaultValue: `Page ${filters.page} of ${totalPages}`,
                    })}
                  </Typography>
                  <Stack direction="row" spacing={1}>
                    <Button disabled={filters.page <= 1} onClick={() => updateFilter('page', filters.page - 1)}>
                      {t('common.previous')}
                    </Button>
                    <Button disabled={filters.page >= totalPages} onClick={() => updateFilter('page', filters.page + 1)}>
                      {t('common.next')}
                    </Button>
                  </Stack>
                </Stack>
              </Paper>
            ) : null}
          </Stack>
        </Stack>
      )}

      <QuestionManagerImportDialog
        open={importDialogOpen}
        loading={actionBusyKey === 'import'}
        selectedFile={importFile}
        ignorePoints={importIgnorePoints}
        importTags={importTags}
        tagSuggestions={tagSuggestionLabels}
        onClose={() => {
          if (actionBusyKey === 'import') return;
          setImportDialogOpen(false);
        }}
        onIgnorePointsChange={setImportIgnorePoints}
        onImportTagsChange={(nextValue) => setImportTags(nextValue.map((value) => String(value || '').trim()).filter(Boolean))}
        onFileChange={setImportFile}
        onConfirm={handleImportQuestions}
      />

      <QuestionManagerExportDialog
        open={exportDialogState.open}
        loading={actionBusyKey === 'export'}
        selectedCount={exportDialogState.fingerprints.length}
        includePoints={exportIncludePoints}
        onClose={() => {
          if (actionBusyKey === 'export') return;
          setExportDialogState({ open: false, fingerprints: [] });
        }}
        onIncludePointsChange={setExportIncludePoints}
        onConfirm={handleExportQuestions}
      />
    </Box>
  );
}
