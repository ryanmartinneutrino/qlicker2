import { useEffect, useRef, useState } from 'react';
import { Alert, MenuItem, TextField } from '@mui/material';
import { useTranslation } from 'react-i18next';
import apiClient from '../../api/client';

export function aiModelValue(backendId, modelId) {
  return backendId && modelId ? `${backendId}::${modelId}` : '';
}

export function parseAiModelValue(value) {
  const [backendId = '', modelId = ''] = String(value || '').split('::');
  return { backendId, modelId };
}

export default function AiModelSelect({ courseId, value, onChange, disabled = false, fullWidth = true, audience = 'instructor' }) {
  const { t } = useTranslation();
  const [models, setModels] = useState([]);
  const [error, setError] = useState('');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let active = true;
    const configPath = audience === 'student'
      ? `/ai/student/courses/${courseId}/config`
      : `/ai/courses/${courseId}/config`;
    apiClient.get(configPath)
      .then(({ data }) => {
        if (!active) return;
        const nextModels = data.approvedModels || [];
        const defaultValue = aiModelValue(data.defaultBackendId, data.defaultModelId);
        setModels(nextModels);
        if (!value || !nextModels.some((model) => aiModelValue(model.backendId, model.modelId) === value)) {
          const nextValue = nextModels.some((model) => aiModelValue(model.backendId, model.modelId) === defaultValue)
            ? defaultValue
            : aiModelValue(nextModels[0]?.backendId, nextModels[0]?.modelId);
          onChangeRef.current(nextValue);
        }
      })
      .catch((err) => {
        if (active) setError(err.response?.data?.message || t('ai.models.failedLoad'));
      });
    return () => { active = false; };
  // Selection remains under the parent while configuration is course-scoped.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audience, courseId, t]);

  if (error) return <Alert severity="error">{error}</Alert>;
  return <TextField
    select
    size="small"
    label={t('ai.models.modelForTask')}
    value={value || ''}
    onChange={(event) => onChange(event.target.value)}
    disabled={disabled || models.length === 0}
    fullWidth={fullWidth}
  >
    {models.map((model) => <MenuItem key={aiModelValue(model.backendId, model.modelId)} value={aiModelValue(model.backendId, model.modelId)}>
      {`${model.backendName} — ${model.modelName}`}
    </MenuItem>)}
  </TextField>;
}
