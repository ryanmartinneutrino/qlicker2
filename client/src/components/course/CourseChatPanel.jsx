import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  IconButton,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  ArchiveOutlined as ArchiveIcon,
  ChatBubbleOutline as CommentIcon,
  DeleteOutline as DeleteIcon,
  ExpandLess as ExpandLessIcon,
  ExpandMore as ExpandMoreIcon,
  ThumbUpOutlined as UpvoteIcon,
} from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import apiClient from '../../api/client';
import StudentIdentity from '../common/StudentIdentity';
import StudentRichTextEditor from '../questions/StudentRichTextEditor';
import {
  extractPlainTextFromHtml,
  prepareRichTextInput,
  renderKatexInElement,
} from '../questions/richTextUtils';

const richContentSx = {
  '& p': { my: 0.5 },
  '& ul, & ol': { my: 0.5, pl: 3 },
  '& img': {
    display: 'block',
    maxWidth: '100% !important',
    height: 'auto !important',
    borderRadius: 0,
    my: 0.75,
  },
};

const CHAT_REFRESH_DEBOUNCE_MS = 150;

function getTimestampMs(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortCoursePosts(posts = []) {
  return [...posts].sort((a, b) => {
    const createdDiff = getTimestampMs(a?.createdAt) - getTimestampMs(b?.createdAt);
    if (createdDiff !== 0) return createdDiff;
    return String(a?._id || '').localeCompare(String(b?._id || ''));
  });
}

function sortComments(comments = []) {
  return [...comments].sort((a, b) => {
    const createdDiff = getTimestampMs(a?.createdAt) - getTimestampMs(b?.createdAt);
    if (createdDiff !== 0) return createdDiff;
    return String(a?._id || '').localeCompare(String(b?._id || ''));
  });
}

function mergeCoursePost(existingPost = {}, incomingPost = {}) {
  return {
    ...existingPost,
    ...incomingPost,
    comments: sortComments(incomingPost?.comments ?? existingPost?.comments ?? []),
    viewerHasUpvoted: incomingPost?.viewerHasUpvoted ?? existingPost?.viewerHasUpvoted ?? false,
    isOwnPost: incomingPost?.isOwnPost ?? existingPost?.isOwnPost ?? false,
  };
}

function applyCourseChatEventData(previousData, eventPayload) {
  if (!previousData || !eventPayload) return null;
  const postId = String(eventPayload?.postId || eventPayload?.post?._id || '');
  let posts = Array.isArray(previousData?.posts) ? [...previousData.posts] : [];

  if (eventPayload?.post !== undefined) {
    if (eventPayload.post) {
      const existingIndex = posts.findIndex((post) => String(post?._id || '') === String(eventPayload.post?._id || ''));
      const mergedPost = mergeCoursePost(posts[existingIndex] || {}, eventPayload.post);
      if (existingIndex >= 0) {
        posts[existingIndex] = mergedPost;
      } else {
        posts.push(mergedPost);
      }
    } else if (postId) {
      posts = posts.filter((post) => String(post?._id || '') !== postId);
    }
  }

  return {
    ...previousData,
    posts: sortCoursePosts(posts),
  };
}

function formatTimestamp(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

function normalizeDraftPlainText(html = '') {
  return extractPlainTextFromHtml(html || '').trim();
}

function getAuthorLabel({ authorName, authorRole, t }) {
  if (authorName) return authorName;
  if (authorRole === 'student') return t('courseChat.anonymousStudent');
  if (authorRole === 'instructor' || authorRole === 'admin') return t('courseChat.instructor');
  return t('courseChat.unknownAuthor');
}

function RichContent({ html, fallback }) {
  const ref = useRef(null);
  const prepared = useMemo(
    () => prepareRichTextInput(html || '', fallback || '', { allowVideoEmbeds: true }),
    [fallback, html]
  );

  useLayoutEffect(() => {
    if (ref.current && prepared) {
      renderKatexInElement(ref.current);
    }
  }, [prepared]);

  if (!prepared) return null;

  return (
    <Box
      ref={ref}
      sx={richContentSx}
      dangerouslySetInnerHTML={{ __html: prepared }}
    />
  );
}

function VoteButton({ onClick, active, disabled, count, label }) {
  return (
    <Button
      size="small"
      color={active ? 'primary' : 'inherit'}
      startIcon={<UpvoteIcon fontSize="small" />}
      onClick={onClick}
      disabled={disabled}
      sx={{ minWidth: 0 }}
    >
      {label} ({count})
    </Button>
  );
}

function CommentItem({
  post,
  comment,
  canViewNames,
  canVote,
  canDelete,
  deletingCommentId,
  onDeleteComment,
  onVoteComment,
  votingCommentId,
}) {
  const { t } = useTranslation();

  return (
    <Paper variant="outlined" sx={{ p: 1.25 }}>
      <Stack spacing={1}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} sx={{ justifyContent: 'space-between' }}>
          <Box sx={{ minWidth: 0, flexGrow: 1 }}>
            {canViewNames && comment.author ? (
              <StudentIdentity student={comment.author} avatarSize={32} />
            ) : (
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {getAuthorLabel({ authorName: comment.authorName, authorRole: comment.authorRole, t })}
              </Typography>
            )}
            <Stack direction="row" spacing={0.75} sx={{ mt: 0.25, flexWrap: 'wrap' }}>
              <Typography variant="caption" color="text.secondary">
                {formatTimestamp(comment.createdAt)}
              </Typography>
              {comment.isOriginalPoster ? <Chip size="small" label={t('courseChat.originalPoster')} variant="outlined" /> : null}
            </Stack>
          </Box>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            {canVote ? (
              <VoteButton
                label={t('courseChat.upvote')}
                count={comment.upvoteCount || 0}
                active={!!comment.viewerHasUpvoted}
                disabled={votingCommentId === comment._id}
                onClick={() => onVoteComment(post._id, comment._id, !comment.viewerHasUpvoted)}
              />
            ) : (
              <Typography variant="caption" color="text.secondary">
                {t('courseChat.upvotesCount', { count: comment.upvoteCount || 0 })}
              </Typography>
            )}
            {canDelete ? (
              <IconButton
                size="small"
                color="error"
                aria-label={t('courseChat.deleteComment')}
                disabled={deletingCommentId === comment._id}
                onClick={() => onDeleteComment(post._id, comment._id)}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            ) : null}
          </Stack>
        </Stack>
        <RichContent html={comment.bodyWysiwyg} fallback={comment.body} />
      </Stack>
    </Paper>
  );
}

export default function CourseChatPanel({
  courseId,
  enabled,
  role = 'student',
  syncTransport = 'unknown',
  refreshToken = 0,
  chatEvent = null,
  initialData = null,
}) {
  const { t } = useTranslation();
  const [chatData, setChatData] = useState(initialData);
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState(null);
  const [composerOpen, setComposerOpen] = useState(role === 'professor');
  const [titleDraft, setTitleDraft] = useState('');
  const [draftHtml, setDraftHtml] = useState('');
  const [selectedTags, setSelectedTags] = useState([]);
  const [tagFilter, setTagFilter] = useState('');
  const [authorFilter, setAuthorFilter] = useState('');
  const [expandedPosts, setExpandedPosts] = useState({});
  const [commentDrafts, setCommentDrafts] = useState({});
  const [pendingCommentId, setPendingCommentId] = useState('');
  const [deletingCommentId, setDeletingCommentId] = useState('');
  const [votingCommentId, setVotingCommentId] = useState('');
  const [submittingPost, setSubmittingPost] = useState(false);
  const dismissedNotificationIdRef = useRef('');
  const chatDataRef = useRef(initialData);
  const fetchInFlightRef = useRef(false);
  const queuedRefreshRef = useRef(false);

  useEffect(() => {
    chatDataRef.current = initialData;
    setChatData(initialData);
    setLoading(!initialData);
  }, [initialData]);

  const fetchChat = useCallback(async () => {
    if (!enabled) {
      chatDataRef.current = null;
      setChatData(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(!chatDataRef.current);
    try {
      const { data } = await apiClient.get(`/courses/${courseId}/chat`);
      chatDataRef.current = data;
      setChatData(data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || t('courseChat.failedToLoad'));
    } finally {
      setLoading(false);
    }
  }, [courseId, enabled, t]);

  const runFetchChat = useCallback(async () => {
    if (fetchInFlightRef.current) {
      queuedRefreshRef.current = true;
      return;
    }

    fetchInFlightRef.current = true;
    try {
      await fetchChat();
    } finally {
      fetchInFlightRef.current = false;
      if (queuedRefreshRef.current) {
        queuedRefreshRef.current = false;
        void runFetchChat();
      }
    }
  }, [fetchChat]);

  useEffect(() => {
    const delayMs = chatDataRef.current ? CHAT_REFRESH_DEBOUNCE_MS : 0;
    const timer = setTimeout(() => {
      void runFetchChat();
    }, delayMs);
    return () => clearTimeout(timer);
  }, [enabled, refreshToken, runFetchChat]);

  useEffect(() => {
    if (!enabled || !chatEvent) return;
    if (!chatDataRef.current) {
      void runFetchChat();
      return;
    }

    const nextData = applyCourseChatEventData(chatDataRef.current, chatEvent);
    if (!nextData) {
      void runFetchChat();
      return;
    }

    chatDataRef.current = nextData;
    setChatData(nextData);
    setError(null);
  }, [chatEvent, enabled, runFetchChat]);

  useEffect(() => {
    const notificationId = String(chatData?.notificationId || '');
    if (!notificationId || dismissedNotificationIdRef.current === notificationId) return;
    dismissedNotificationIdRef.current = notificationId;
    apiClient.post(`/notifications/${notificationId}/dismiss`).catch(() => {
      dismissedNotificationIdRef.current = '';
    });
  }, [chatData?.notificationId]);

  const canCompose = !!chatData?.canPost;
  const canVote = !!chatData?.canVote && role === 'student';
  const canViewNames = !!chatData?.canViewNames;
  const canDeleteAnyPost = !!chatData?.canDeleteAnyPost;
  const canDeleteOwnPost = !!chatData?.canDeleteOwnPost;
  const canDeleteAnyComment = !!chatData?.canDeleteAnyComment;
  const canDeleteOwnComment = !!chatData?.canDeleteOwnComment;
  const canArchive = !!chatData?.canArchive;
  const shouldRefetchAfterMutation = syncTransport !== 'websocket';
  const shouldRefetchAfterStudentMutation = shouldRefetchAfterMutation || role === 'student';
  const draftHasContent = normalizeDraftPlainText(draftHtml).length > 0 || (draftHtml || '').trim().length > 0;
  const availableTags = useMemo(() => chatData?.availableTags || [], [chatData?.availableTags]);

  const userFilterOptions = useMemo(() => {
    const map = new Map();
    (chatData?.posts || []).forEach((post) => {
      if (post?.authorId && post?.author) {
        map.set(String(post.authorId), {
          value: String(post.authorId),
          label: post.author.displayName || post.authorName || post.author.email || String(post.authorId),
        });
      }
    });
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [chatData?.posts]);

  const filteredPosts = useMemo(() => {
    const posts = sortCoursePosts(chatData?.posts || []);
    return posts.filter((post) => {
      const matchesTag = !tagFilter || (post?.tags || []).includes(tagFilter);
      const matchesAuthor = !authorFilter || String(post?.authorId || '') === String(authorFilter);
      return matchesTag && matchesAuthor;
    });
  }, [authorFilter, chatData?.posts, tagFilter]);

  const clearComposer = useCallback(() => {
    setTitleDraft('');
    setDraftHtml('');
    setSelectedTags([]);
  }, []);

  const handleSubmitPost = useCallback(async () => {
    if (!canCompose || !draftHasContent || !titleDraft.trim() || submittingPost) return;
    setSubmittingPost(true);
    try {
      await apiClient.post(`/courses/${courseId}/chat/posts`, {
        title: titleDraft.trim(),
        body: normalizeDraftPlainText(draftHtml),
        bodyWysiwyg: draftHtml,
        tags: selectedTags,
      });
      clearComposer();
      setComposerOpen(role === 'professor');
      setError(null);
      if (shouldRefetchAfterStudentMutation) {
        await fetchChat();
      }
    } catch (err) {
      setError(err.response?.data?.message || t('courseChat.failedToSend'));
    } finally {
      setSubmittingPost(false);
    }
  }, [canCompose, clearComposer, courseId, draftHasContent, draftHtml, fetchChat, role, selectedTags, shouldRefetchAfterStudentMutation, submittingPost, t, titleDraft]);

  const handleVotePost = useCallback(async (postId, upvoted) => {
    try {
      await apiClient.patch(`/courses/${courseId}/chat/posts/${postId}/vote`, { upvoted });
      setError(null);
      if (shouldRefetchAfterStudentMutation) {
        await fetchChat();
      }
    } catch (err) {
      setError(err.response?.data?.message || t('courseChat.failedToVote'));
    }
  }, [courseId, fetchChat, shouldRefetchAfterStudentMutation, t]);

  const handleVoteComment = useCallback(async (postId, commentId, upvoted) => {
    setVotingCommentId(commentId);
    try {
      await apiClient.patch(`/courses/${courseId}/chat/posts/${postId}/comments/${commentId}/vote`, { upvoted });
      setError(null);
      if (shouldRefetchAfterStudentMutation) {
        await fetchChat();
      }
    } catch (err) {
      setError(err.response?.data?.message || t('courseChat.failedToVote'));
    } finally {
      setVotingCommentId('');
    }
  }, [courseId, fetchChat, shouldRefetchAfterStudentMutation, t]);

  const handleSubmitComment = useCallback(async (postId) => {
    const draft = commentDrafts[postId] || '';
    if (!normalizeDraftPlainText(draft) && !draft.trim()) return;
    setPendingCommentId(postId);
    try {
      await apiClient.post(`/courses/${courseId}/chat/posts/${postId}/comments`, {
        body: normalizeDraftPlainText(draft),
        bodyWysiwyg: draft,
      });
      setCommentDrafts((prev) => ({ ...prev, [postId]: '' }));
      setExpandedPosts((prev) => ({ ...prev, [postId]: true }));
      setError(null);
      if (shouldRefetchAfterStudentMutation) {
        await fetchChat();
      }
    } catch (err) {
      setError(err.response?.data?.message || t('courseChat.failedToComment'));
    } finally {
      setPendingCommentId('');
    }
  }, [commentDrafts, courseId, fetchChat, shouldRefetchAfterStudentMutation, t]);

  const handleDeletePost = useCallback(async (postId) => {
    try {
      await apiClient.delete(`/courses/${courseId}/chat/posts/${postId}`);
      setError(null);
      if (shouldRefetchAfterStudentMutation) {
        await fetchChat();
      }
    } catch (err) {
      setError(err.response?.data?.message || t('courseChat.failedToDelete'));
    }
  }, [courseId, fetchChat, shouldRefetchAfterStudentMutation, t]);

  const handleArchivePost = useCallback(async (postId) => {
    try {
      await apiClient.patch(`/courses/${courseId}/chat/posts/${postId}/archive`);
      setError(null);
      if (shouldRefetchAfterMutation) {
        await fetchChat();
      }
    } catch (err) {
      setError(err.response?.data?.message || t('courseChat.failedToArchive'));
    }
  }, [courseId, fetchChat, shouldRefetchAfterMutation, t]);

  const handleDeleteComment = useCallback(async (postId, commentId) => {
    setDeletingCommentId(commentId);
    try {
      await apiClient.delete(`/courses/${courseId}/chat/posts/${postId}/comments/${commentId}`);
      setError(null);
      if (shouldRefetchAfterStudentMutation) {
        await fetchChat();
      }
    } catch (err) {
      setError(err.response?.data?.message || t('courseChat.failedToDelete'));
    } finally {
      setDeletingCommentId('');
    }
  }, [courseId, fetchChat, shouldRefetchAfterStudentMutation, t]);

  if (!enabled) {
    return <Alert severity="info">{t('courseChat.disabled')}</Alert>;
  }

  if (loading) {
    return (
      <Box sx={{ py: 4, display: 'flex', justifyContent: 'center' }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Stack spacing={2}>
      {error ? <Alert severity="error">{error}</Alert> : null}
      <Alert severity="info">
        {role === 'professor' ? t('courseChat.instructorNotice') : t('courseChat.studentNotice')}
      </Alert>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1.5}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', alignItems: { sm: 'center' } }}>
            <Typography variant="h6">{t('courseChat.title')}</Typography>
            {canCompose ? (
              <Button
                variant={composerOpen ? 'outlined' : 'contained'}
                startIcon={<AddIcon />}
                onClick={() => setComposerOpen((prev) => !prev)}
              >
                {composerOpen ? t('courseChat.hideComposer') : t('courseChat.newPost')}
              </Button>
            ) : null}
          </Stack>

          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
            <Autocomplete
              size="small"
              options={availableTags}
              getOptionLabel={(option) => option.label || option.value || ''}
              value={availableTags.find((option) => option.value === tagFilter) || null}
              onChange={(_, value) => setTagFilter(value?.value || '')}
              renderInput={(params) => <TextField {...params} label={t('courseChat.filterByTag')} />}
              sx={{ minWidth: { md: 220 } }}
            />
            {canViewNames ? (
              <Autocomplete
                size="small"
                options={userFilterOptions}
                getOptionLabel={(option) => option.label || ''}
                value={userFilterOptions.find((option) => option.value === authorFilter) || null}
                onChange={(_, value) => setAuthorFilter(value?.value || '')}
                renderInput={(params) => <TextField {...params} label={t('courseChat.filterByUser')} />}
                sx={{ minWidth: { md: 240 } }}
              />
            ) : null}
          </Stack>

          {composerOpen ? (
            <Stack spacing={1.25}>
              <TextField
                label={t('courseChat.topic')}
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                inputProps={{ maxLength: 160 }}
              />
              <Autocomplete
                multiple
                options={availableTags}
                getOptionLabel={(option) => option.label || option.value || ''}
                value={availableTags.filter((option) => selectedTags.includes(option.value))}
                onChange={(_, values) => setSelectedTags(values.map((value) => value.value))}
                renderInput={(params) => <TextField {...params} label={t('courseChat.tags')} />}
              />
              <StudentRichTextEditor
                value={draftHtml}
                onChange={({ html }) => setDraftHtml(html)}
                placeholder={t('courseChat.postPlaceholder')}
                ariaLabel={t('courseChat.postEditorLabel')}
                enableVideo
              />
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, flexWrap: 'wrap' }}>
                <Button onClick={clearComposer}>{t('common.clear')}</Button>
                <Button
                  variant="contained"
                  onClick={handleSubmitPost}
                  disabled={!titleDraft.trim() || !draftHasContent || submittingPost}
                >
                  {t('courseChat.publishPost')}
                </Button>
              </Box>
            </Stack>
          ) : null}
        </Stack>
      </Paper>

      {filteredPosts.length === 0 ? (
        <Alert severity="info">{t('courseChat.noPosts')}</Alert>
      ) : filteredPosts.map((post) => {
        const expanded = !!expandedPosts[post._id];
        const canDeletePost = canDeleteAnyPost || (canDeleteOwnPost && post.isOwnPost);
        return (
          <Paper key={post._id} variant="outlined" sx={{ p: 2 }}>
            <Stack spacing={1.25}>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ justifyContent: 'space-between' }}>
                <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                  {canViewNames && post.author ? (
                    <StudentIdentity student={post.author} avatarSize={40} emailVariant="body2" />
                  ) : (
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>
                      {getAuthorLabel({ authorName: post.authorName, authorRole: post.authorRole, t })}
                    </Typography>
                  )}
                  <Typography variant="h6" sx={{ mt: 0.75 }}>{post.title}</Typography>
                  <Stack direction="row" spacing={0.75} sx={{ mt: 0.5, flexWrap: 'wrap' }}>
                    <Typography variant="caption" color="text.secondary">{formatTimestamp(post.createdAt)}</Typography>
                    <Typography variant="caption" color="text.secondary">{t('courseChat.commentsCount', { count: post.comments.length })}</Typography>
                    <Typography variant="caption" color="text.secondary">{t('courseChat.upvotesCount', { count: post.upvoteCount || 0 })}</Typography>
                  </Stack>
                </Box>
                <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  {canVote ? (
                    <VoteButton
                      label={t('courseChat.upvote')}
                      count={post.upvoteCount || 0}
                      active={!!post.viewerHasUpvoted}
                      onClick={() => handleVotePost(post._id, !post.viewerHasUpvoted)}
                    />
                  ) : null}
                  {canArchive ? (
                    <IconButton size="small" aria-label={t('courseChat.archivePost')} onClick={() => handleArchivePost(post._id)}>
                      <ArchiveIcon fontSize="small" />
                    </IconButton>
                  ) : null}
                  {canDeletePost ? (
                    <IconButton size="small" color="error" aria-label={t('courseChat.deletePost')} onClick={() => handleDeletePost(post._id)}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  ) : null}
                </Stack>
              </Stack>

              {(post.tags || []).length > 0 ? (
                <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
                  {post.tags.map((tag) => (
                    <Chip key={`${post._id}-${tag}`} size="small" label={availableTags.find((entry) => entry.value === tag)?.label || tag} />
                  ))}
                </Stack>
              ) : null}

              <RichContent html={post.bodyWysiwyg} fallback={post.body} />

              <Button
                size="small"
                color="inherit"
                onClick={() => setExpandedPosts((prev) => ({ ...prev, [post._id]: !expanded }))}
                startIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                sx={{ alignSelf: 'flex-start' }}
              >
                {t('courseChat.commentsCount', { count: post.comments.length })}
              </Button>

              <Collapse in={expanded} unmountOnExit>
                <Stack spacing={1.25} sx={{ mt: 1 }}>
                  {post.comments.map((comment) => {
                    const canDeleteComment = canDeleteAnyComment || (canDeleteOwnComment && comment.isOwnComment);
                    return (
                      <CommentItem
                        key={comment._id}
                        post={post}
                        comment={comment}
                        canViewNames={canViewNames}
                        canVote={canVote}
                        canDelete={canDeleteComment}
                        deletingCommentId={deletingCommentId}
                        onDeleteComment={handleDeleteComment}
                        onVoteComment={handleVoteComment}
                        votingCommentId={votingCommentId}
                      />
                    );
                  })}
                  <Divider />
                  <StudentRichTextEditor
                    value={commentDrafts[post._id] || ''}
                    onChange={({ html }) => setCommentDrafts((prev) => ({ ...prev, [post._id]: html }))}
                    placeholder={t('courseChat.commentPlaceholder')}
                    ariaLabel={t('courseChat.commentEditorLabel')}
                    enableVideo
                  />
                  <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <Button
                      variant="contained"
                      startIcon={<CommentIcon />}
                      onClick={() => handleSubmitComment(post._id)}
                      disabled={pendingCommentId === post._id}
                    >
                      {t('courseChat.addComment')}
                    </Button>
                  </Box>
                </Stack>
              </Collapse>
            </Stack>
          </Paper>
        );
      })}
    </Stack>
  );
}
