import { useState } from 'react';
import { Alert, Box, Button, Checkbox, FormControlLabel, MenuItem, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';

export default function AiGradingForm({ value = {}, instructions, onChange, onSaveInstruction, onDeleteInstruction }) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState({});
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const choose = (kind, id) => {
    const instruction = instructions.find((entry) => entry._id === id);
    onChange({ ...value, [kind]: instruction?.content || '', [`${kind}InstructionId`]: id });
    setEditing(null);
  };
  const begin = (kind) => {
    const selected = instructions.find((entry) => entry._id === value?.[`${kind}InstructionId`]);
    setDrafts((current) => ({ ...current, [kind]: { id: selected?._id || '', name: selected?.name || '', content: selected?.content || value?.[kind] || '' } }));
    setEditing(kind); setMessage('');
  };
  const save = async (kind) => {
    const draft = drafts[kind]; if (!draft?.name?.trim() || !draft?.content?.trim()) return;
    setSaving(true); setMessage('');
    try { const instruction = await onSaveInstruction({ _id: draft.id, kind, name: draft.name, content: draft.content }); choose(kind, instruction._id); setMessage(t('grades.aiGrading.instructionSaved')); }
    finally { setSaving(false); }
  };
  return <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
    <Typography variant="h6">{t('grades.aiGrading.formTitle')}</Typography>
    {message ? <Alert severity="success">{message}</Alert> : null}
    {['grading', 'feedback'].map((kind) => {
      const selectedInstruction = instructions.find((entry) => entry._id === value?.[`${kind}InstructionId`]);
      return <Box key={kind}>
      <TextField select fullWidth label={t(`grades.aiGrading.${kind}Instructions`)} value={value?.[`${kind}InstructionId`] || ''} onChange={(event) => choose(kind, event.target.value)}>
        <MenuItem value="">{t('grades.aiGrading.selectInstruction')}</MenuItem>
        {instructions.filter((entry) => entry.kind === kind).map((entry) => <MenuItem key={entry._id} value={entry._id}>{entry.name}</MenuItem>)}
      </TextField>
      {selectedInstruction && editing !== kind ? <Box sx={{ mt: 1, p: 1, borderLeft: 3, borderColor: 'primary.main', bgcolor: 'action.hover' }}><Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{selectedInstruction.content}</Typography><Button size="small" color="error" sx={{ mt: 0.5 }} disabled={selectedInstruction._id === 'no-feedback'} onClick={() => onDeleteInstruction(selectedInstruction)}>{t('common.delete')}</Button></Box> : null}
      {editing !== kind ? <Button size="small" sx={{ mt: 0.5 }} onClick={() => begin(kind)}>{value?.[`${kind}InstructionId`] ? t('common.edit') : t('grades.aiGrading.createInstruction')}</Button> : <Box sx={{ display: 'flex', gap: 1, mt: 1, flexDirection: 'column' }}>
        <Alert severity="info">{t('grades.aiGrading.unsavedInstructionWarning')}</Alert>
        <TextField size="small" label={t('common.name')} value={drafts[kind]?.name || ''} onChange={(e) => setDrafts((current) => ({ ...current, [kind]: { ...current[kind], name: e.target.value } }))} />
        <TextField multiline minRows={3} label={t(`grades.aiGrading.${kind}Instructions`)} value={drafts[kind]?.content || ''} onChange={(e) => setDrafts((current) => ({ ...current, [kind]: { ...current[kind], content: e.target.value } }))} />
        <Box><Button size="small" variant="contained" disabled={saving || !drafts[kind]?.name?.trim() || !drafts[kind]?.content?.trim()} onClick={() => save(kind)}>{saving ? t('common.saving') : t('common.save')}</Button><Button size="small" sx={{ ml: 1 }} onClick={() => setEditing(null)}>{t('common.cancel')}</Button></Box>
      </Box>}
    </Box>;
    })}
    <FormControlLabel control={<Checkbox checked={!!value?.regrade} onChange={(event) => onChange({ ...value, regrade: event.target.checked })} />} label={t('grades.aiGrading.regrade')} />
  </Box>;
}
