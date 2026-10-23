import i18n from './index';
const zh = {
  open: '引用会话摘录', title: '选择会话摘录', query: '搜索会话内容', search: '搜索', searching: '搜索中…',
  hint: '输入关键词并搜索，然后选择一段材料插入草稿。发送后，群成员都能看到这段摘录。',
  empty: '没有匹配的会话内容。', partial: '部分来源不支持搜索或读取失败，结果可能不完整。',
  more: '更多结果', choose: '选择这段摘录', selected: '确认摘录内容', insert: '插入草稿',
  source: '来源', session: '会话', message: '消息', time: '采集时间', unknown: '未提供',
  excerptTitle: '用户确认的会话摘录', scope: '范围：搜索结果节选；完整性未知，不代表完整会话。',
  limit: '摘录最多 8 KiB；插入后的整条消息最多 32 KiB。', invalid: '摘录为空、格式无效或超过大小限制。',
  tooLarge: '当前草稿加上摘录超过消息大小限制，原草稿已保留。',
};
const en: Record<keyof typeof zh, string> = {
  open: 'Quote conversation excerpt', title: 'Choose a conversation excerpt', query: 'Search conversations', search: 'Search', searching: 'Searching…',
  hint: 'Search for a phrase, then select material to insert into your draft. Group members can read the excerpt after you send it.',
  empty: 'No matching conversation content.', partial: 'Some sources cannot be searched or failed to respond. Results may be incomplete.',
  more: 'More results', choose: 'Choose this excerpt', selected: 'Confirm excerpt text', insert: 'Insert into draft',
  source: 'Source', session: 'Conversation', message: 'Message', time: 'Collected at', unknown: 'Not provided',
  excerptTitle: 'User-confirmed conversation excerpt', scope: 'Scope: search result excerpt; completeness unknown. This is not a complete conversation.',
  limit: 'Excerpt limit: 8 KiB. The combined message limit is 32 KiB.', invalid: 'The excerpt is empty, invalid, or exceeds the size limit.',
  tooLarge: 'The combined message exceeds the size limit. Your original draft is kept.',
};
i18n.addResourceBundle('zh-CN', 'translation', { groupChat: { reference: zh } }, true, true);
i18n.addResourceBundle('en', 'translation', { groupChat: { reference: en } }, true, true);
