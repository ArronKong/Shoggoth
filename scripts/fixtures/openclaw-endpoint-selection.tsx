import React from "react";
import { createRoot } from "react-dom/client";
import CustomEndpointsPanel from "../../app/manage-ui/src/pages/models/CustomEndpointsPanel";
import { createOpenClawEndpointController } from "../../app/manage-ui/src/pages/models/openclaw-endpoint-controller";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const transport = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const response = await transport(input, init);
  const state = await transport("/__fixture/state").then(result => result.json());
  const output = document.getElementById("preview-result");
  if (output) output.textContent = JSON.stringify(state);
  return response;
};
const controller = createOpenClawEndpointController("openclaw");
await applyConfiguredLocale("zh-CN");
createRoot(document.getElementById("root")!).render(<UiProvider>
  <aside style={{ padding: 24 }}>
    OpenClaw 模型重选 · 真实保存链路 / 隔离网关配置
    <output id="preview-result" style={{ display: "block", fontSize: 12 }}>尚无写入</output>
  </aside>
  <main className="page management-page">
    <div className="page-head"><div><h1>模型</h1><p>OpenClaw</p></div></div>
    <CustomEndpointsPanel controller={controller} active onChanged={() => {}} />
  </main>
</UiProvider>);
