import { useState } from 'react';
import { Box, Button, Checkbox, FormControlLabel, MenuItem, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';

export default function AiGradingForm({ value, instructions, onChange }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(null);
  const choose = (kind, id) => {
    const instruction = instructions.find((entry) => entry._id === id);
    onChange({ ...value, [kind]: instruction?.content || '', [`${kind}InstructionId`]: id });
  };
  return <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
    <Typography variant="h6">{t('grades.aiGrading.formTitle')}</Typography>
    {['grading', 'feedback'].map((kind) => <Box key={kind}>
      <TextField select fullWidth label={t(`grades.aiGrading.${kind}Instructions`)} value={value?.[`${kind}InstructionId`] || ''} onChange={(event) => choose(kind, event.target.value)}>
        <MenuItem value="">{t('grades.aiGrading.selectInstruction')}</MenuItem>
        {instructions.filter((entry) => entry.kind === kind).map((entry) => <MenuItem key={entry._id} value={entry._id}>{entry.name}</MenuItem>)}
      </TextField>
      <Button size="small" sx={{ mt: 0.5 }} onClick={() => setEditing(editing === kind ? null : kind)}>{t('grades.aiGrading.createInstruction')}</Button>
      {editing === kind && <Box sx={{ display: 'flex', gap: 1, mt: 1, flexDirection: 'column' }}>
        <TextField size="small" label={t('common.name')} value={value?.[`${kind}Name`] || ''} onChange={(e) => onChange({ ...value, [`${kind}Name`]: e.target.value })} />
        <TextField multiline minRows={3} label={t(`grades.aiGrading.${kind}Instructions`)} value={value?.[kind] || ''} onChange={(e) => onChange({ ...value, [kind]: e.target.value })} />
      </Box>}
    </Box>)}
    <FormControlLabel control={<Checkbox checked={!!value?.regrade} onChange={(event) => onChange({ ...value, regrade: event.target.checked })} />} label={t('grades.aiGrading.regrade')} />
  </Box>;
}
