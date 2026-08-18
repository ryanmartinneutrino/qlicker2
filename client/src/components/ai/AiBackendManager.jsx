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

export default function AiBackendManager({ backends = [], onChange, defaultBackendId = '', defaultModelId = '', onDefaultChange, courseId = '', canAddBackends = true }) {
  const { t } = useTranslation();
  const [discovering, setDiscovering] = useState({});
  const [error, setError] = useState('');

  const updateBackend = (backendId, update) => onChange(backends.map((backend) => (
    backend.id === backendId ? { ...backend, ...update } : backend
  )));
  const discover = async (backend) => {
    setDiscovering((current) => ({ ...current, [backend.id]: true })); setError('');
    try {
      const { data } = await apiClient.post('/ai/discover-models', {
        url: backend.url,
        type: backend.type,
        apiToken: backend.apiToken || '',
        ...(courseId ? { courseId } : {}),
      });
      const existing = new Map((backend.models || []).map((model) => [model.id, model]));
      updateBackend(backend.id, { models: (data.models || []).map((model) => ({ ...model, available: existing.get(model.id)?.available !== false })) });
    } catch (err) { setError(err.response?.data?.message || t('ai.backends.discoveryFailed')); }
    finally { setDiscovering((current) => ({ ...current, [backend.id]: false })); }
  };

  return <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
    {error ? <Alert severity="error" onClose={() => setError('')}>{error}</Alert> : null}
    {backends.map((backend, index) => <Paper key={backend.id} variant="outlined" sx={{ p: 1.5 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography variant="subtitle2">{t('ai.backends.backendNumber', { number: index + 1 })}</Typography>
        <IconButton aria-label={t('ai.backends.removeBackend')} onClick={() => onChange(backends.filter((entry) => entry.id !== backend.id))}><DeleteIcon /></IconButton>
      </Box>
      <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', md: '1fr 150px' } }}>
        <TextField size="small" label={t('ai.backends.name')} value={backend.name || ''} onChange={(event) => updateBackend(backend.id, { name: event.target.value })} />
        <TextField select size="small" label={t('ai.backends.type')} value={backend.type || 'ollama'} onChange={(event) => updateBackend(backend.id, { type: event.target.value })}>
          <MenuItem value="ollama">Ollama</MenuItem><MenuItem value="openai">OpenAI-compatible</MenuItem>
        </TextField>
      </Box>
      <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
        <TextField size="small" label={t('ai.backends.url')} value={backend.url || ''} onChange={(event) => updateBackend(backend.id, { url: event.target.value })} placeholder="http://localhost:11434" sx={{ flex: 1, minWidth: 260 }} />
        <TextField size="small" type="password" label={t('ai.backends.apiToken')} value={backend.apiToken || ''} onChange={(event) => updateBackend(backend.id, { apiToken: event.target.value })} placeholder={backend.apiTokenSet ? t('ai.backends.tokenConfigured') : ''} sx={{ flex: 1, minWidth: 220 }} />
        <Button variant="outlined" startIcon={<DiscoverIcon />} disabled={!backend.url || backend.type !== 'ollama' || discovering[backend.id]} onClick={() => discover(backend)}>{t('ai.backends.discoverModels')}</Button>
      </Box>
      {(backend.models || []).length > 0 ? <>
        <Divider sx={{ my: 1.25 }} />
        <Typography variant="caption" color="text.secondary">{t('ai.backends.modelsHelp')}</Typography>
        {(backend.models || []).map((model) => <Box key={model.id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <FormControlLabel control={<Checkbox checked={model.available !== false} onChange={(event) => updateBackend(backend.id, { models: backend.models.map((entry) => entry.id === model.id ? { ...entry, available: event.target.checked } : entry) })} />} label={model.name} />
          <Button size="small" variant={defaultBackendId === backend.id && defaultModelId === model.id ? 'contained' : 'outlined'} onClick={() => onDefaultChange(backend.id, model.id)}>{t('ai.backends.makeDefault')}</Button>
        </Box>)}
      </> : null}
    </Paper>)}
    {canAddBackends ? <Button startIcon={<AddIcon />} variant="outlined" onClick={() => onChange([...backends, newBackend()])}>{t('ai.backends.addBackend')}</Button> : null}
  </Box>;
}
