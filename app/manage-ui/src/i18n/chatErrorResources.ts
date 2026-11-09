import zh from "../../../agent-service/chat-error-messages.json";
import en from "./chatErrorMessages.en";
import i18n from "./index";

// Load public error copy with the pages that display it.
i18n.addResourceBundle("zh-CN", "chatErrors", zh);
i18n.addResourceBundle("en", "chatErrors", en);
