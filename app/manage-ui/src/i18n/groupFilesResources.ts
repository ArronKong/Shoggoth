import i18n from './index';

const zh = {
  open: '群文件', title: '群文件 {{count}}', loading: '正在读取群文件，已找到 {{count}} 个…',
  empty: '此群还没有共享文件。', failed: '群文件暂时无法读取。',
  partial: '较早的文件未能全部读取；当前显示已读取的 {{count}} 个文件。',
  changed: '群文件的来源已变化，请关闭后重新打开。', retry: '重新读取',
  reveal: '在文件夹中显示 {{name}}', revealFailed: '文件暂不可用，无法在文件夹中显示。',
  unknownMember: '已离开的成员', me: '我',
};
const en: Record<keyof typeof zh, string> = {
  open: 'Group files', title: 'Group Files {{count}}', loading: 'Loading group files · {{count}} found…',
  empty: 'No files have been shared in this group yet.', failed: 'Group files are temporarily unavailable.',
  partial: 'Earlier files could not all be read. Showing {{count}} files loaded so far.',
  changed: 'The source of these files changed. Close and reopen group files.', retry: 'Try again',
  reveal: 'Show {{name}} in folder', revealFailed: 'This file is unavailable and could not be shown in its folder.',
  unknownMember: 'Former member', me: 'Me',
};

i18n.addResourceBundle('zh-CN', 'translation', { groupChat: { files: zh } }, true, true);
i18n.addResourceBundle('en', 'translation', { groupChat: { files: en } }, true, true);
