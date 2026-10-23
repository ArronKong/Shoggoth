import i18n from "./index";

// Load with the interaction cards, keeping their copy out of the startup bundle.
const zh = {
  promptChooseOption: "选择方案",
  promptConfirmChoice: "确认选择",
  promptOptional: "选填",
  promptOtherPlaceholder: "或填写其他答案…",
};
const en = {
  promptChooseOption: "Choose an option",
  promptConfirmChoice: "Confirm selection",
  promptOptional: "Optional",
  promptOtherPlaceholder: "Or write another answer…",
} satisfies typeof zh;
i18n.addResourceBundle("zh-CN", "translation", { chat: zh }, true, true);
i18n.addResourceBundle("en", "translation", { chat: en }, true, true);
