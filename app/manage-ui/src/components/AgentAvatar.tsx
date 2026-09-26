import { useLayoutEffect, useRef, useState } from "react";
import styles from "./AgentAvatar.module.css";

type AgentAvatarProps = {
  agentId?: string;
  name?: string;
  fallback?: string;
  className?: string;
  version?: number;
  loading?: "eager" | "lazy";
};

export default function AgentAvatar(props: AgentAvatarProps) {
  const src = props.agentId
    ? `/avatar/${encodeURIComponent(props.agentId)}${props.version ? `?v=${props.version}` : ""}`
    : "";
  // A new identity/version gets fresh loading state, including after a failure.
  return <AvatarImage key={src} {...props} src={src} />;
}

function AvatarImage({ className, loading, src }: AgentAvatarProps & { src: string }) {
  const [state, setState] = useState<"loading" | "loaded" | "fallback">(src ? "loading" : "fallback");
  const imageRef = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    // Cached images can be ready at mount; avoid painting a fallback over them.
    const image = imageRef.current;
    if (image?.complete) setState(image.naturalWidth > 0 ? "loaded" : "fallback");
  }, []);
  const loaded = state === "loaded";
  return (
    <span
      className={`${styles.avatar}${className ? ` ${className}` : ""}`}
      data-avatar-state={state}
      style={{ background: loaded ? "transparent" : undefined }}
      aria-hidden="true"
    >
      {src && state !== "fallback" && (
        <img
          ref={imageRef}
          src={src}
          alt=""
          draggable={false}
          loading={loading}
          onLoad={() => setState("loaded")}
          onError={() => setState("fallback")}
        />
      )}
    </span>
  );
}
