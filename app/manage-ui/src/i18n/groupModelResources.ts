import i18n from './index';
const zh = {
  label: '群内模型', follow: '跟随 Agent 默认模型',
  hint: '仅用于本群，从下一次回复或任务生效。',
  currentDefault: '当前默认：{{model}}', loading: '正在读取可用模型…',
  loadError: '暂时无法读取模型目录，请重试。', retry: '重试',
  missing: '所选模型暂不在可用目录中，可重新选择或跟随默认。',
  saving: '正在保存…', saved: '群内模型已更新',
};
const en: Record<keyof typeof zh, string> = {
  label: 'Model in this group', follow: 'Follow Agent default model',
  hint: 'Applies only to this group, starting with the next reply or task.',
  currentDefault: 'Current default: {{model}}', loading: 'Loading available models…',
  loadError: 'Could not load available models. Try again.', retry: 'Retry',
  missing: 'The selected model is no longer listed. Choose another model or follow the default.',
  saving: 'Saving…', saved: 'Group model updated',
};
i18n.addResourceBundle('zh-CN', 'translation', { groupChat: { model: zh } }, true, true);
i18n.addResourceBundle('en', 'translation', { groupChat: { model: en } }, true, true);
