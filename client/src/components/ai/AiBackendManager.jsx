import { useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Divider, FormControlLabel, IconButton, MenuItem, Paper, TextField, Typography,
} from '@mui/material';
import { Add as AddIcon, DeleteOutline as DeleteIcon, Refresh as DiscoverIcon } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import apiClient from '../../api/client';

function newBackend() {
  return { id: `backend-${crypto.randomUUID()}`, name: '', type: 'ollama', url: '', apiToken: '', models: [] };
}

const MASKED_TOKEN = '********';

export default function AiBackendManager({
  backends = [],
  onChange,
  defaultBackendId = '',
  defaultModelId = '',
  onDefaultChange,
  courseId = '',
  canAddBackends = true,
  modelPolicies = [],
  onModelPoliciesChange,
  readOnly = false,
}) {
  const { t } = useTranslation();
  const [discovering, setDiscovering] = useState({});
  const [expandedModels, setExpandedModels] = useState({});
  const [error, setError] = useState('');

  const updateBackend = (backendId, update, options) => {
    const nextBackends = backends.map((backend) => (
      backend.id === backendId ? { ...backend, ...update } : backend
    ));
    if (options) onChange(nextBackends, options);
    else onChange(nextBackends);
  };
  const policyFor = (backendId, modelId) => modelPolicies.find((entry) => (
    entry.backendId === backendId && entry.modelId === modelId
  ));
  const updateModelPolicy = (backendId, modelId, update) => {
    const existing = policyFor(backendId, modelId);
    if (update.approved === false) {
      onModelPoliciesChange(modelPolicies.filter((entry) => !(entry.backendId === backendId && entry.modelId === modelId)));
      return;
    }
    const next = { backendId, modelId, studentAvailable: existing?.studentAvailable || false, ...update };
    delete next.approved;
    onModelPoliciesChange([
      ...modelPolicies.filter((entry) => !(entry.backendId === backendId && entry.modelId === modelId)),
      next,
    ]);
  };
  const discover = async (backend) => {
    setDiscovering((current) => ({ ...current, [backend.id]: true })); setError('');
    try {
      const { data } = await apiClient.post('/ai/discover-models', {
        backendId: backend.id,
        url: backend.url,
        type: backend.type,
        apiToken: backend.apiToken || '',
        ...(courseId ? { courseId } : {}),
      });
      const existing = new Map((backend.models || []).map((model) => [model.id, model]));
      updateBackend(backend.id, { models: (data.models || []).map((model) => ({ ...model, available: existing.get(model.id)?.available !== false })) });
      setExpandedModels((current) => ({ ...current, [backend.id]: true }));
    } catch (err) { setError(err.response?.data?.message || t('ai.backends.discoveryFailed')); }
    finally { setDiscovering((current) => ({ ...current, [backend.id]: false })); }
  };

  return <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
    {error ? <Alert severity="error" onClose={() => setError('')}>{error}</Alert> : null}
    {backends.map((backend, index) => {
      const models = backend.models || [];
      const visibleModels = !courseId || expandedModels[backend.id]
        ? models
        : models.filter((model) => !!policyFor(backend.id, model.id));
      return <Paper key={backend.id} variant="outlined" sx={{ p: 1.5 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, mb: 1 }}>
          <Typography variant="subtitle2">{readOnly ? (backend.name || backend.url) : t('ai.backends.backendNumber', { number: index + 1 })}</Typography>
          {!readOnly ? <IconButton aria-label={t('ai.backends.removeBackend')} onClick={() => onChange(backends.filter((entry) => entry.id !== backend.id))}><DeleteIcon /></IconButton> : null}
        </Box>
        {!readOnly ? <>
          <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', md: '1fr 150px' } }}>
            <TextField size="small" label={t('ai.backends.name')} value={backend.name || ''} onChange={(event) => updateBackend(backend.id, { name: event.target.value })} />
            <TextField select size="small" label={t('ai.backends.type')} value={backend.type || 'ollama'} onChange={(event) => updateBackend(backend.id, { type: event.target.value })}>
              <MenuItem value="ollama">Ollama</MenuItem><MenuItem value="openai">OpenAI-compatible</MenuItem>
            </TextField>
          </Box>
          <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
            <TextField size="small" label={t('ai.backends.url')} value={backend.url || ''} onChange={(event) => updateBackend(backend.id, { url: event.target.value })} placeholder="http://localhost:11434" sx={{ flex: 1, minWidth: 260 }} />
            <TextField size="small" type="password" label={t('ai.backends.apiToken')} value={backend.apiToken || (backend.apiTokenSet ? MASKED_TOKEN : '')} onFocus={(event) => { if (!backend.apiToken && backend.apiTokenSet) event.target.select(); }} onClick={(event) => { if (!backend.apiToken && backend.apiTokenSet) event.target.select(); }} onChange={(event) => updateBackend(backend.id, { apiToken: event.target.value === MASKED_TOKEN ? '' : event.target.value })} onBlur={() => { if (backend.apiToken) onChange(backends, { saveImmediately: true }); }} sx={{ flex: 1, minWidth: 220 }} />
            <Button variant="outlined" startIcon={<DiscoverIcon />} disabled={!backend.url || discovering[backend.id]} onClick={() => discover(backend)}>{t('ai.backends.showAvailableModels')}</Button>
          </Box>
        </> : null}
        {readOnly ? <Button size="small" variant="outlined" startIcon={<DiscoverIcon />} disabled={!backend.url || discovering[backend.id]} onClick={() => discover(backend)}>{t('ai.backends.showAvailableModels')}</Button> : null}
        {visibleModels.length > 0 ? <>
          <Divider sx={{ my: 1.25 }} />
          <Typography variant="caption" color="text.secondary">{t('ai.backends.modelsHelp')}</Typography>
          {visibleModels.map((model) => {
            const modelPolicy = policyFor(backend.id, model.id);
            const isDefault = defaultBackendId === backend.id && defaultModelId === model.id;
            return <Box key={model.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              {courseId ? <>
                <FormControlLabel control={<Checkbox checked={!!modelPolicy} disabled={isDefault} onChange={(event) => updateModelPolicy(backend.id, model.id, { approved: event.target.checked })} />} label={model.name} />
                {modelPolicy ? <FormControlLabel control={<Checkbox inputProps={{ 'aria-label': `${model.name}: ${t('ai.backends.availableToStudents')}` }} checked={!!modelPolicy.studentAvailable} onChange={(event) => updateModelPolicy(backend.id, model.id, { studentAvailable: event.target.checked })} />} label={t('ai.backends.availableToStudents')} /> : null}
              </> : <>
                <FormControlLabel control={<Checkbox checked={model.available !== false} onChange={(event) => updateBackend(backend.id, { models: backend.models.map((entry) => entry.id === model.id ? { ...entry, available: event.target.checked } : entry) })} />} label={model.name} />
                <Button size="small" variant={isDefault ? 'contained' : 'outlined'} onClick={() => onDefaultChange(backend.id, model.id)}>{t('ai.backends.makeDefault')}</Button>
              </>}
            </Box>;
          })}
        </> : null}
      </Paper>;
    })}
    {canAddBackends && !readOnly ? <Button startIcon={<AddIcon />} variant="outlined" onClick={() => onChange([...backends, newBackend()])}>{t('ai.backends.addBackend')}</Button> : null}
  </Box>;
}
