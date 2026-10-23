import i18n from './index';

i18n.addResourceBundle('zh-CN', 'translation', { groupChat: {
  delete: '删除群', deleteConfirm: '删除后将停止本群所有讨论和排队动作，并移除这个群。无法撤销，不影响其他群、单聊或共享账号。',
  deletingNotice: '正在删除群：已禁止新动作，正在等待本群执行确认停止。',
  archivedPlaceholder: '群聊已归档',
  sidebar: { waiting: '等待你的回应', reading: '回答待读取', stopping: '正在请求停止',
    queued: '排队等待执行', deleting: '删除中 · 等待停止确认', queueBlocked: '排队中 · 旧执行待核对' },
  queueBlocked: '这个工作区有尚未核对完的旧执行，当前回合还未启动。',
} }, true, true);
i18n.addResourceBundle('en', 'translation', { groupChat: {
  delete: 'Delete group', deleteConfirm: 'Stop all discussions and queued actions in this group, then remove it? This cannot be undone. Other groups, direct chats and shared accounts are unaffected.',
  deletingNotice: 'Deleting group: new actions are blocked while its executions confirm they have stopped.',
  archivedPlaceholder: 'This group is archived',
  sidebar: { waiting: 'Waiting for your response', reading: 'Answer pending retrieval', stopping: 'Requesting stop',
    queued: 'Queued for execution', deleting: 'Deleting · awaiting stop confirmation', queueBlocked: 'Queued · earlier execution unconfirmed' },
  queueBlocked: 'An earlier execution in this workspace is still being checked. This turn has not started.',
} }, true, true);

i18n.addResourceBundle('zh-CN', 'translation', { groupChat: { stopState: { requesting: '正在请求停止讨论…', confirming: '停止请求已发出，正在等待成员确认停止。' }, search: { open: '搜索群历史' },
  reference: { open: '引用会话摘录', tooLarge: '当前草稿加上摘录超过消息大小限制，原草稿已保留。' } } }, true, true);
i18n.addResourceBundle('en', 'translation', { groupChat: { stopState: { requesting: 'Requesting discussion stop…', confirming: 'Stop requested. Waiting for members to confirm they have stopped.' }, search: { open: 'Search group history' },
  reference: { open: 'Quote conversation excerpt', tooLarge: 'The combined message exceeds the size limit. Your original draft is kept.' } } }, true, true);
