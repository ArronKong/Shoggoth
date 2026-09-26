import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PageHead } from "../components/PageHead";
import BackendTabs, { type BackendId } from "../components/BackendTabs";
import BackendBadge from "../components/BackendBadge";
import FilterTabs from "../components/FilterTabs";
import { Field, TextInput, TextArea, Select, Option, Switch } from "../components/Field";
import Modal, { ModalSection, DetailRow } from "../components/Modal";
import FusionLoader from "../components/FusionLoader";
import LiquidGooeyDemo from "../components/LiquidGooeyDemo";
import { useToast, useConfirm } from "../components/ui";
import styles from "./ComponentsPage.module.css";

// 字面名是 Apple 的官方 style name，与字体家族名同属专有名词，不进 i18n。
const SF_WEIGHTS = [
  { value: 100, name: "Ultralight" },
  { value: 200, name: "Thin" },
  { value: 300, name: "Light" },
  { value: 400, name: "Regular" },
  { value: 500, name: "Medium" },
  { value: 600, name: "Semibold" },
  { value: 700, name: "Bold" },
  { value: 800, name: "Heavy" },
  { value: 900, name: "Black" },
];

// PingFang.ttc 的 OS/2 表里是六个字面（usWeightClass 100/200/300/400/500/600，没有 Bold），
// 但 Chromium 只渲染得出五档 —— 200 与 300 像素完全一致（映射到同一字面），600 以上没有
// 更粗的字面可选时也不合成加粗，而是直接钳位回 Semibold。两种情况都照实标出来。
const PINGFANG_WEIGHTS = [
  { value: 100, name: "Ultralight", note: null },
  { value: 200, name: "Thin", note: "shared" },
  { value: 300, name: "Light", note: "shared" },
  { value: 400, name: "Regular", note: null },
  { value: 500, name: "Medium", note: null },
  { value: 600, name: "Semibold", note: null },
  { value: 700, name: "Bold", note: "clamped" },
  { value: 800, name: "Heavy", note: "clamped" },
  { value: 900, name: "Black", note: "clamped" },
];

const PINGFANG_VARIANTS = ["PingFang SC", "PingFang TC", "PingFang HK", "PingFang MO"];

// 文件名以点号开头 = 隐藏字体，font-family 匹配不到；local() 又被 Chromium 禁用。
const HIDDEN_FONTS = [
  { label: "New York", family: ".New York" },
  { label: "SF Mono", family: ".SF NS Mono" },
  { label: "SF Compact", family: ".SF Compact" },
  { label: "SF Pro Rounded", family: ".SF NS Rounded" },
];

// 样张不进 i18n：它存在的意义是展示字形，翻译它没有意义。
const SF_SAMPLE = "Hamburgefonstiv 0123456789";
const PINGFANG_SAMPLE = "中文字体排版测试 0123456789";
// 用纯标点：实测四个变体的汉字字形完全相同，唯一真实差异是标点位置（简体居左下、
// 繁/港/澳居中）。且这差异只在“整串没有汉字”时才显现 —— 一旦混入汉字，Chromium
// 就改按 lang 而非 font-family 定地区字形，四行会渲染得完全一样。
const PINGFANG_PUNCTUATION_SAMPLE = "，。、；：？！";

// 组件展厅直接组合生产共享组件；所有演示状态只存在于当前路由生命周期内。
export default function ComponentsPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [textValue, setTextValue] = useState(() => t("componentsGallery.textDefault"));
  const [textareaValue, setTextareaValue] = useState(() => t("componentsGallery.textareaDefault"));
  const [selectValue, setSelectValue] = useState("openclaw");
  const [switchChecked, setSwitchChecked] = useState(true);
  const [backend, setBackend] = useState<BackendId>("openclaw");
  const [filterValue, setFilterValue] = useState("");
  const [scrollFilterValue, setScrollFilterValue] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmResult, setConfirmResult] = useState<"confirmed" | "cancelled" | null>(null);

  // 确认弹窗只把结果写回本页，绝不触发业务请求或持久化操作。
  const handleConfirm = async () => {
    const confirmed = await confirm({
      title: t("componentsGallery.confirmTitle"),
      message: t("componentsGallery.confirmMessage"),
      confirmLabel: t("componentsGallery.confirmAccept"),
      cancelLabel: t("componentsGallery.confirmCancel"),
    });
    setConfirmResult(confirmed ? "confirmed" : "cancelled");
  };

  return (
    <div className={`page management-page components-page ${styles.pageRoot}`}>
      <PageHead title={t("componentsGallery.title")} subtitle={t("componentsGallery.subtitle")} />

      <main className={styles.grid}>
        <section className={`${styles.card} ${styles.wide}`}>
          <header className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>{t("componentsGallery.buttonsTitle")}</h2>
              <p className={styles.cardDescription}>{t("componentsGallery.buttonsDescription")}</p>
            </div>
            <span className={styles.kind}>{t("componentsGallery.sharedStyle")}</span>
          </header>
          <div className={styles.specGroup}>
            <span className={styles.specLabel}>{t("componentsGallery.buttonVariants")}</span>
            <div className={`${styles.sample} ${styles.actions}`}>
              <button type="button" className="btn-primary">{t("componentsGallery.primaryButton")}</button>
              <button type="button" className="btn-dark">{t("componentsGallery.darkButton")}</button>
              <button type="button" className="btn-secondary">{t("componentsGallery.secondaryButton")}</button>
              <button type="button" className="btn-subtle">{t("componentsGallery.subtleButton")}</button>
              <button type="button" className="btn-danger">{t("componentsGallery.dangerButton")}</button>
            </div>
          </div>
          <div className={styles.specGroup}>
            <span className={styles.specLabel}>{t("componentsGallery.buttonStates")}</span>
            {/* is-hover / is-pressed 是「按钮系统」(styles.css) 专为这份规范镜像留的
                静态展示钩子——把只在指针下才出现的两态摆出来，业务页不用。 */}
            <div className={`${styles.sample} ${styles.actions}`}>
              <button type="button" className="btn-primary">{t("componentsGallery.stateDefault")}</button>
              <button type="button" className="btn-primary is-hover">{t("componentsGallery.stateHover")}</button>
              <button type="button" className="btn-primary is-pressed">{t("componentsGallery.statePressed")}</button>
              <button type="button" className="btn-primary" disabled>{t("componentsGallery.disabledButton")}</button>
            </div>
          </div>
          <div className={styles.specGroup}>
            <span className={styles.specLabel}>{t("componentsGallery.buttonSizes")}</span>
            <div className={`${styles.sample} ${styles.actions}`}>
              <button type="button" className="btn-primary">{t("componentsGallery.sizeLarge")}</button>
              <button type="button" className="btn-primary btn-md">{t("componentsGallery.sizeMedium")}</button>
              <button type="button" className="btn-primary btn-sm">{t("componentsGallery.sizeSmall")}</button>
            </div>
          </div>
        </section>

        <section className={`${styles.card} ${styles.wide}`}>
          <header className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>{t("componentsGallery.fieldsTitle")}</h2>
              <p className={styles.cardDescription}>{t("componentsGallery.fieldsDescription")}</p>
            </div>
          </header>
          <div className={styles.fieldGrid}>
            <Field label={t("componentsGallery.textLabel")} hint={t("componentsGallery.textHint")}>
              <TextInput data-gallery="text-input" value={textValue} onChange={(event) => setTextValue(event.target.value)} />
            </Field>
            <Field label={t("componentsGallery.textareaLabel")} hint={t("componentsGallery.textareaHint")}>
              <TextArea data-gallery="textarea" value={textareaValue} onChange={(event) => setTextareaValue(event.target.value)} rows={3} />
            </Field>
            <Field label={t("componentsGallery.selectLabel")}>
              <Select value={selectValue} onChange={setSelectValue}>
                <Option value="openclaw">{t("componentsGallery.optionOpenClaw")}</Option>
                <Option value="hermes">{t("componentsGallery.optionHermes")}</Option>
              </Select>
            </Field>
            <div className={styles.switchRow}>
              <Switch checked={switchChecked} onChange={setSwitchChecked} label={t("componentsGallery.switchLabel")} />
            </div>
          </div>
        </section>

        <section className={styles.card}>
          <header className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>{t("componentsGallery.navigationTitle")}</h2>
              <p className={styles.cardDescription}>{t("componentsGallery.navigationDescription")}</p>
            </div>
          </header>
          <div className={styles.stack}>
            <BackendTabs value={backend} onChange={setBackend} />
            <div className={styles.badgeRow}>
              <span>{t("componentsGallery.badgeLabel")}</span>
              <BackendBadge backendId={backend} />
            </div>
          </div>
        </section>

        <LiquidGooeyDemo />

        <section className={`${styles.card} ${styles.wide}`}>
          <header className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>{t("componentsGallery.filterTabsTitle")}</h2>
              <p className={styles.cardDescription}>{t("componentsGallery.filterTabsDescription")}</p>
            </div>
            <span className={styles.kind}>{t("componentsGallery.sharedStyle")}</span>
          </header>
          <div className={styles.stack}>
            {/* 基础：Dashboard 活动流筛选就是这个形态 */}
            <FilterTabs
              ariaLabel={t("componentsGallery.filterTabsTitle")}
              value={filterValue}
              onChange={setFilterValue}
              items={[
                { value: "", label: t("componentsGallery.filterAll") },
                { value: "cron", label: t("componentsGallery.filterCron") },
                { value: "kanban", label: t("componentsGallery.filterKanban") },
                { value: "system", label: t("componentsGallery.filterSystem") },
              ]}
            />
            {/* 横向滚动 + 再点回落：模型菜单的 provider 筛选就是这个形态 */}
            <FilterTabs
              scrollable
              toggleOff=""
              ariaLabel={t("componentsGallery.filterTabsScrollable")}
              value={scrollFilterValue}
              onChange={setScrollFilterValue}
              items={[
                { value: "", label: t("componentsGallery.filterAll") },
                ...["anthropic", "deepseek", "modelscope", "nvidia", "openai", "openrouter", "xai"].map(
                  (p) => ({ value: p, label: p, title: p }),
                ),
              ]}
            />
            <p className={styles.cardDescription}>{t("componentsGallery.filterTabsNote")}</p>
          </div>
        </section>

        <section className={styles.card}>
          <header className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>{t("componentsGallery.feedbackTitle")}</h2>
              <p className={styles.cardDescription}>{t("componentsGallery.feedbackDescription")}</p>
            </div>
          </header>
          <div className={`${styles.sample} ${styles.actions}`}>
            <button type="button" className="btn-secondary" data-gallery="toast-success" onClick={() => toast.success(t("componentsGallery.toastSuccessMessage"))}>{t("componentsGallery.toastSuccessAction")}</button>
            <button type="button" className="btn-secondary" data-gallery="toast-info" onClick={() => toast.info(t("componentsGallery.toastInfoMessage"))}>{t("componentsGallery.toastInfoAction")}</button>
            <button type="button" className="btn-secondary" data-gallery="toast-error" onClick={() => toast.error(t("componentsGallery.toastErrorMessage"))}>{t("componentsGallery.toastErrorAction")}</button>
            <button type="button" data-gallery="confirm" className="btn-primary" onClick={handleConfirm}>{t("componentsGallery.confirmAction")}</button>
          </div>
          <p className={styles.result} data-gallery="confirm-result" aria-live="polite">
            {confirmResult === "confirmed"
              ? t("componentsGallery.confirmConfirmed")
              : confirmResult === "cancelled"
                ? t("componentsGallery.confirmCancelled")
                : t("componentsGallery.confirmIdle")}
          </p>
        </section>

        <section className={styles.card}>
          <header className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>{t("componentsGallery.loaderTitle")}</h2>
              <p className={styles.cardDescription}>{t("componentsGallery.loaderDescription")}</p>
            </div>
          </header>
          <div className={styles.loaderGrid}>
            <div className={`${styles.loaderSample} ${styles.fusionSwatch}`} data-gallery="fusion-loader">
              <span className={styles.specLabel}>{t("componentsGallery.fusionLoaderName")}</span>
              <div className={`${styles.sample} ${styles.actions}`}>
                <FusionLoader size="sm" label={t("common.loading")} />
                <FusionLoader label={t("componentsGallery.fusionLoaderLabel")} />
              </div>
            </div>
          </div>
        </section>

        <section className={`${styles.card} ${styles.wide}`}>
          <header className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>{t("componentsGallery.overlaysTitle")}</h2>
              <p className={styles.cardDescription}>{t("componentsGallery.overlaysDescription")}</p>
            </div>
          </header>
          <div className={`${styles.sample} ${styles.actions}`}>
            <button type="button" className="btn-primary" data-gallery="open-modal" onClick={() => setModalOpen(true)}>{t("componentsGallery.openModal")}</button>
          </div>
        </section>

        <section className={`${styles.card} ${styles.wide}`} data-gallery="font-sf">
          <header className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>{t("componentsGallery.sfTitle")}</h2>
              <p className={styles.cardDescription}>{t("componentsGallery.sfDescription")}</p>
            </div>
            <span className={styles.kind}>{t("componentsGallery.sfKind")}</span>
          </header>
          <ul className={styles.fontList}>
            {SF_WEIGHTS.map((weight) => (
              <li key={weight.value} className={styles.fontRow}>
                <span className={styles.weightMeta}>
                  <b className={styles.weightValue}>{weight.value}</b>
                  <span className={styles.weightName}>{weight.name}</span>
                </span>
                <span className={styles.fontSample} style={{ fontFamily: "system-ui", fontWeight: weight.value }}>
                  {SF_SAMPLE}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className={`${styles.card} ${styles.wide}`} data-gallery="font-pingfang">
          <header className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>{t("componentsGallery.pingfangTitle")}</h2>
              <p className={styles.cardDescription}>{t("componentsGallery.pingfangDescription")}</p>
            </div>
            <span className={styles.kind}>{t("componentsGallery.pingfangKind")}</span>
          </header>
          <ul className={styles.fontList}>
            {PINGFANG_WEIGHTS.map((weight) => (
              <li key={weight.value} className={`${styles.fontRow} ${weight.note ? styles.fontRowClamped : ""}`}>
                <span className={styles.weightMeta}>
                  <b className={styles.weightValue}>{weight.value}</b>
                  <span className={styles.weightName}>{weight.name}</span>
                  {weight.note ? (
                    <span className={styles.clampTag}>
                      {t(weight.note === "clamped"
                        ? "componentsGallery.pingfangClamped"
                        : "componentsGallery.pingfangShared")}
                    </span>
                  ) : null}
                </span>
                <span className={styles.fontSample} style={{ fontFamily: '"PingFang SC"', fontWeight: weight.value }}>
                  {PINGFANG_SAMPLE}
                </span>
              </li>
            ))}
          </ul>

          <div className={styles.subSection}>
            <h3 className={styles.subTitle}>{t("componentsGallery.pingfangVariantsTitle")}</h3>
            <p className={styles.cardDescription}>{t("componentsGallery.pingfangVariantsDescription")}</p>
            <p className={styles.note}>{t("componentsGallery.pingfangVariantsCaveat")}</p>
            <ul className={styles.fontList}>
              {PINGFANG_VARIANTS.map((family) => (
                <li key={family} className={styles.fontRow}>
                  <span className={styles.weightMeta}>
                    <span className={styles.weightName}>{family}</span>
                  </span>
                  <span className={styles.glyphSample} style={{ fontFamily: `"${family}"` }}>
                    {PINGFANG_PUNCTUATION_SAMPLE}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className={`${styles.card} ${styles.wide}`} data-gallery="font-hidden">
          <header className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>{t("componentsGallery.unreachableTitle")}</h2>
              <p className={styles.cardDescription}>{t("componentsGallery.unreachableDescription")}</p>
            </div>
          </header>
          <ul className={styles.hiddenList}>
            {HIDDEN_FONTS.map((font) => (
              <li key={font.family} className={styles.hiddenRow}>
                <span className={styles.hiddenLabel}>{font.label}</span>
                <code className={styles.hiddenFamily}>{font.family}</code>
              </li>
            ))}
          </ul>
          <p className={styles.note}>{t("componentsGallery.unreachableWhy")}</p>
          <p className={styles.note}>{t("componentsGallery.unreachableNote")}</p>
        </section>
      </main>

      {/* R370 抽屉退役后浮层只剩一种：演示弹窗顺带展示 ModalSection + DetailRow。 */}
      <Modal
        open={modalOpen}
        title={t("componentsGallery.modalTitle")}
        subtitle={t("componentsGallery.modalSubtitle")}
        onClose={() => setModalOpen(false)}
        footer={<button type="button" className="btn-primary" onClick={() => setModalOpen(false)}>{t("componentsGallery.closeOverlay")}</button>}
      >
        <p className={styles.modalCopy}>{t("componentsGallery.modalBody")}</p>
        <ModalSection title={t("componentsGallery.detailSectionTitle")}>
          <DetailRow label={t("componentsGallery.detailBackendLabel")}>
            <BackendBadge backendId={backend} />
          </DetailRow>
        </ModalSection>
      </Modal>
    </div>
  );
}
