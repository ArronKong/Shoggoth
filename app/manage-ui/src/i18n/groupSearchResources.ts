import i18n from './index';
const zh = {
  open: '搜索群历史', title: '搜索此群的公开消息', hint: '搜索已保存的用户与成员公开发言，不读取私聊或系统状态。按字面匹配，英文字母不区分大小写。',
  query: '搜索内容', search: '搜索', searching: '搜索中…', author: '作者', allAuthors: '所有作者', user: '我',
  request: '请求范围', allRequests: '全部历史请求', knownRequests: '下拉列表列出近期请求；选择全部可搜索更早历史。',
  more: '继续搜索较早消息', empty: '本页没有匹配消息。', finished: '已搜索完此范围。',
  snapshot: '本次搜索截至消息 #{{seq}}；再次搜索可包含新消息。',
  partial: '部分旧成员消息没有保存全文，只能搜索仍保留的正文；未命中不代表原全文中不存在。',
  partialHit: '旧记录 · 正文可能不完整', read: '读取保存正文', sequence: '消息 #{{seq}}',
  invalid: '搜索范围或来源不一致，请重新搜索。', failed: '搜索暂不可用，请重试。',
};
const en: Record<keyof typeof zh, string> = {
  open: 'Search group history', title: 'Search public messages in this group', hint: 'Search saved user and member posts. Private chats and system status are excluded. Matches literal text; English letters are case-insensitive.',
  query: 'Search text', search: 'Search', searching: 'Searching…', author: 'Author', allAuthors: 'All authors', user: 'Me',
  request: 'Request scope', allRequests: 'All historical requests', knownRequests: 'The list contains recent requests. Choose all to search older history too.',
  more: 'Search earlier messages', empty: 'No matches on this page.', finished: 'Search complete for this scope.',
  snapshot: 'This search includes messages through #{{seq}}. Search again to include newer messages.',
  partial: 'Some older member messages have no saved full text. Only retained text is searchable; no match does not prove the original text lacked it.',
  partialHit: 'Older record · text may be incomplete', read: 'Read saved text', sequence: 'Message #{{seq}}',
  invalid: 'The search scope or source does not match. Search again.', failed: 'Search is temporarily unavailable. Try again.',
};
i18n.addResourceBundle('zh-CN', 'translation', { groupChat: { search: zh } }, true, true);
i18n.addResourceBundle('en', 'translation', { groupChat: { search: en } }, true, true);
