import iconTextDocuments from "../assets/artifact-icons/icon_textdocuments.png";
import iconImagesGraphics from "../assets/artifact-icons/icon_imagesgraphics.png";
import iconAudioVideo from "../assets/artifact-icons/icon_audiovideo.png";
import iconArchiveCompression from "../assets/artifact-icons/icon_archivecompression.png";
import iconExecutableSystem from "../assets/artifact-icons/icon_executablesystem.png";
import iconWebSourceCode from "../assets/artifact-icons/icon_websourcecode.png";
import styles from "./ArtifactThumb.module.css";

// 产出文件按后缀归 6 大类（通用文件管理器口径，不特判本机数据）；未匹配 → 文本与文档兜底。
type ArtifactCategory =
  | "textdocuments" | "imagesgraphics" | "audiovideo"
  | "archivecompression" | "executablesystem" | "websourcecode";

const ARTIFACT_CATEGORY_ICONS: Record<ArtifactCategory, string> = {
  textdocuments: iconTextDocuments,
  imagesgraphics: iconImagesGraphics,
  audiovideo: iconAudioVideo,
  archivecompression: iconArchiveCompression,
  executablesystem: iconExecutableSystem,
  websourcecode: iconWebSourceCode,
};

// 后缀（小写、不含点）→ 类别。json/csv/yaml 归网页与代码（按用户口径）；.xlsx→文档、.dmg→执行、.iso→压缩。
const ARTIFACT_EXT_CATEGORY: Record<string, ArtifactCategory> = {
  md: "textdocuments", markdown: "textdocuments", txt: "textdocuments", pdf: "textdocuments",
  doc: "textdocuments", docx: "textdocuments", xls: "textdocuments", xlsx: "textdocuments",
  ppt: "textdocuments", pptx: "textdocuments", rtf: "textdocuments", odt: "textdocuments",
  pages: "textdocuments", key: "textdocuments", numbers: "textdocuments", epub: "textdocuments", tex: "textdocuments",
  jpg: "imagesgraphics", jpeg: "imagesgraphics", png: "imagesgraphics", gif: "imagesgraphics",
  svg: "imagesgraphics", psd: "imagesgraphics", webp: "imagesgraphics", heic: "imagesgraphics",
  bmp: "imagesgraphics", tiff: "imagesgraphics", tif: "imagesgraphics", ico: "imagesgraphics",
  ai: "imagesgraphics", sketch: "imagesgraphics", fig: "imagesgraphics", avif: "imagesgraphics",
  mp3: "audiovideo", wav: "audiovideo", flac: "audiovideo", aac: "audiovideo", ogg: "audiovideo",
  m4a: "audiovideo", mp4: "audiovideo", mkv: "audiovideo", mov: "audiovideo", avi: "audiovideo",
  webm: "audiovideo", wmv: "audiovideo", flv: "audiovideo", m4v: "audiovideo",
  zip: "archivecompression", rar: "archivecompression", "7z": "archivecompression", iso: "archivecompression",
  tar: "archivecompression", gz: "archivecompression", tgz: "archivecompression", bz2: "archivecompression", xz: "archivecompression",
  exe: "executablesystem", msi: "executablesystem", app: "executablesystem", dmg: "executablesystem",
  pkg: "executablesystem", dll: "executablesystem", deb: "executablesystem", rpm: "executablesystem",
  apk: "executablesystem", bin: "executablesystem", so: "executablesystem", sys: "executablesystem",
  html: "websourcecode", htm: "websourcecode", css: "websourcecode", py: "websourcecode",
  js: "websourcecode", ts: "websourcecode", tsx: "websourcecode", jsx: "websourcecode",
  java: "websourcecode", json: "websourcecode", csv: "websourcecode", yaml: "websourcecode",
  yml: "websourcecode", toml: "websourcecode", xml: "websourcecode", sh: "websourcecode",
  go: "websourcecode", rs: "websourcecode", c: "websourcecode", cpp: "websourcecode", h: "websourcecode",
  rb: "websourcecode", php: "websourcecode", sql: "websourcecode", ipynb: "websourcecode", vue: "websourcecode",
};

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i >= name.length - 1) return "";
  return name.slice(i + 1).toLowerCase();
}
// 后缀标签（大写、最长 4 字符），叠加在图标上；隐藏文件 / 无后缀 → 空。
function extLabel(name: string): string {
  return extOf(name).slice(0, 4).toUpperCase();
}
function artifactCategory(name: string): ArtifactCategory {
  return ARTIFACT_EXT_CATEGORY[extOf(name)] || "textdocuments";
}

// 后缀文字颜色（叠在图标左下角，各类一色 @ 50% 透明度，随图标配色，用户指定）。
const ARTIFACT_CATEGORY_EXT_COLORS: Record<ArtifactCategory, string> = {
  textdocuments: "rgba(255, 196, 89, 0.5)", // FFC459
  websourcecode: "rgba(255, 196, 89, 0.5)", // FFC459
  imagesgraphics: "rgba(255, 128, 130, 0.5)", // FF8082
  audiovideo: "rgba(217, 108, 199, 0.5)", // D96CC7
  archivecompression: "rgba(238, 196, 119, 0.5)", // EEC477
  executablesystem: "rgba(81, 145, 255, 0.5)", // 5191FF
};

// 产出缩略图：一律按 6 大类文件夹图标（含图片，不走真实预览），
// 后缀印在左下角，颜色随类别。
export default function ArtifactThumb({ name }: { name: string }) {
  const ext = extLabel(name);
  const category = artifactCategory(name);
  return (
    <span className={styles.thumb} data-artifact-thumb data-artifact-category={category}>
      <img className={styles.icon} src={ARTIFACT_CATEGORY_ICONS[category]} alt="" aria-hidden="true" />
      {ext ? (
        <span className={styles.extension} style={{ color: ARTIFACT_CATEGORY_EXT_COLORS[category] }}>
          {ext}
        </span>
      ) : null}
    </span>
  );
}
