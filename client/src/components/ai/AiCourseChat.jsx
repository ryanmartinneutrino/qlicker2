import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, CircularProgress, IconButton, List, ListItemButton, ListItemText, Paper, Typography } from '@mui/material';
import { Add as AddIcon, DeleteOutline as DeleteIcon } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import apiClient from '../../api/client';
import StudentRichTextEditor from '../questions/StudentRichTextEditor';
import { extractPlainTextFromHtml } from '../questions/richTextUtils';

function formatMessageTime(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function normalizeDraft(value) {
  if (typeof value === 'string') {
    return { html: value, plainText: extractPlainTextFromHtml(value) };
  }
  const html = String(value?.html || '');
  return { html, plainText: String(value?.plainText ?? extractPlainTextFromHtml(html)) };
}

function normalizeMarkdownMath(value) {
  return String(value || '')
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => `$$\n${math.trim()}\n$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => `$${math.trim()}$`);
}

const markdownSx = {
  overflowWrap: 'anywhere',
  '& > :first-of-type': { mt: 0 },
  '& > :last-child': { mb: 0 },
  '& p, & ul, & ol, & blockquote, & pre, & table': { my: 0.75 },
  '& ul, & ol': { pl: 3 },
  '& blockquote': { borderLeft: 3, borderColor: 'divider', pl: 1.25, ml: 0, color: 'text.secondary' },
  '& pre': { overflowX: 'auto', p: 1, borderRadius: 1, bgcolor: 'action.hover' },
  '& code': { fontFamily: 'monospace', fontSize: '0.9em' },
  '& :not(pre) > code': { px: 0.4, py: 0.15, borderRadius: 0.5, bgcolor: 'action.hover' },
  '& table': { borderCollapse: 'collapse', maxWidth: '100%' },
  '& th, & td': { border: 1, borderColor: 'divider', p: 0.6, textAlign: 'left' },
};

function AssistantMessage({ content }) {
  return <Box sx={markdownSx}>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
      {normalizeMarkdownMath(content)}
    </ReactMarkdown>
  </Box>;
}

export default function AiCourseChat({ courseId }) {
  const { t } = useTranslation();
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState({ html: '', plainText: '' });
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const loadConversations = async () => {
    setLoading(true); setError('');
    try { const { data } = await apiClient.get(`/ai/courses/${courseId}/conversations`); setConversations(data.conversations || []); }
    catch (err) { setError(err.response?.data?.message || t('ai.chat.failedLoad')); }
    finally { setLoading(false); }
  };
  useEffect(() => { loadConversations(); }, [courseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const createConversation = async () => {
    try {
      const { data } = await apiClient.post(`/ai/courses/${courseId}/conversations`);
      setConversations((current) => [data.conversation, ...current]); setSelected(data.conversation);
    } catch (err) { setError(err.response?.data?.message || t('ai.chat.failedLoad')); }
  };
  const selectConversation = async (id) => {
    try { const { data } = await apiClient.get(`/ai/courses/${courseId}/conversations/${id}`); setSelected(data.conversation); }
    catch (err) { setError(err.response?.data?.message || t('ai.chat.failedLoad')); }
  };
  const deleteConversation = async (id) => {
    try {
      await apiClient.delete(`/ai/courses/${courseId}/conversations/${id}`);
      setConversations((current) => current.filter((item) => item._id !== id));
      if (selected?._id === id) setSelected(null);
    } catch (err) { setError(err.response?.data?.message || t('ai.chat.failedLoad')); }
  };
  const send = async () => {
    const content = draft.plainText.trim();
    if (!content || sending) return;
    let conversation = selected;
    if (!conversation) {
      try { const { data } = await apiClient.post(`/ai/courses/${courseId}/conversations`); conversation = data.conversation; setSelected(conversation); }
      catch (err) { setError(err.response?.data?.message || t('ai.chat.failedSend')); return; }
    }
    setSending(true); setError('');
    try {
      const { data } = await apiClient.post(`/ai/courses/${courseId}/conversations/${conversation._id}/messages`, { content, contentWysiwyg: draft.html });
      setSelected(data.conversation); setDraft({ html: '', plainText: '' });
      setConversations((current) => [data.conversation, ...current.filter((item) => item._id !== data.conversation._id)]);
    } catch (err) { setError(err.response?.data?.message || t('ai.chat.failedSend')); }
    finally { setSending(false); }
  };
  const handleDraftKeyDown = useCallback((event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.nativeEvent?.isComposing) return false;
    event.preventDefault();
    send();
    return true;
  }, [send]);
  const messages = useMemo(() => selected?.messages || [], [selected]);

  return <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '250px minmax(0, 1fr)' }, gap: 1.5 }}>
    <Paper variant="outlined" sx={{ p: 1 }}>
      <Button fullWidth startIcon={<AddIcon />} variant="outlined" onClick={createConversation}>{t('ai.chat.newConversation')}</Button>
      {loading ? <Box sx={{ p: 2, textAlign: 'center' }}><CircularProgress size={22} /></Box> : <List dense>
        {conversations.length ? conversations.map((conversation) => <ListItemButton key={conversation._id} selected={selected?._id === conversation._id} onClick={() => selectConversation(conversation._id)}>
          <ListItemText primary={conversation.title || t('ai.chat.newConversation')} secondary={formatMessageTime(conversation.updatedAt)} />
          <IconButton size="small" aria-label={t('ai.chat.deleteConversation')} onClick={(event) => { event.stopPropagation(); deleteConversation(conversation._id); }}><DeleteIcon fontSize="small" /></IconButton>
        </ListItemButton>) : <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>{t('ai.chat.noConversations')}</Typography>}
      </List>}
    </Paper>
    <Paper variant="outlined" sx={{ p: 1.5, display: 'flex', flexDirection: 'column', minHeight: 520 }}>
      {error ? <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError('')}>{error}</Alert> : null}
      <Box sx={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1.25, mb: 1.5 }}>
        {!selected ? <Typography color="text.secondary">{t('ai.chat.selectConversation')}</Typography> : messages.map((message) => <Paper key={message._id} variant="outlined" sx={{ p: 1.25, alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '90%', bgcolor: message.role === 'user' ? 'action.hover' : 'background.paper' }}>
          <Typography variant="caption" color="text.secondary">{message.role === 'user' ? t('ai.chat.you') : t('ai.chat.assistant')}</Typography>
          {message.role === 'assistant'
            ? <AssistantMessage content={message.content} />
            : <Typography sx={{ whiteSpace: 'pre-wrap' }}>{message.content}</Typography>}
        </Paper>)}
      </Box>
      <StudentRichTextEditor value={draft.html} onChange={(value) => setDraft(normalizeDraft(value))} onKeyDown={handleDraftKeyDown} placeholder={t('ai.chat.messagePlaceholder')} minHeight={110} />
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}><Button variant="contained" disabled={sending || !draft.plainText.trim()} onClick={send}>{sending ? <CircularProgress size={20} color="inherit" /> : t('ai.chat.send')}</Button></Box>
    </Paper>
  </Box>;
}
