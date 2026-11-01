import { jsonFetch } from "./client";

export type AppleDeviceResource = "calendar" | "reminders";
export type AppleDeviceReadPolicy = "allow" | "ask" | "deny";
export type AppleDeviceWritePolicy = "allow" | "ask" | "deny";
export type AppleDeviceAuthorization = "notDetermined" | "fullAccess" | "writeOnly" | "denied" | "restricted" | "unavailable";
export interface AppleDeviceConnection {
  id: AppleDeviceResource;
  authorization: AppleDeviceAuthorization;
  enabled: boolean;
  readPolicy: AppleDeviceReadPolicy;
  writePolicy: AppleDeviceWritePolicy;
  disabledProfileIds: string[];
}
export interface AppleDeviceStatus {
  revision: number;
  available: boolean;
  errorCode: string | null;
  resources: AppleDeviceConnection[];
}
export const APPLE_DEVICE_CHANGE_EVENT = "shoggoth:apple-devices-changed";
const write = <T,>(name: string, input: object) => jsonFetch<T>(`/__api/connectors/apple/${name}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
}).then(result => { window.dispatchEvent(new Event(APPLE_DEVICE_CHANGE_EVENT)); return result; });

export const getAppleDeviceStatus = (signal?: AbortSignal) => jsonFetch<AppleDeviceStatus>("/__api/connectors/apple/status", { signal });
export const connectAppleDevice = (resource: AppleDeviceResource, expectedRevision: number) => write<AppleDeviceStatus>("connect", { resource, expectedRevision });
export const saveAppleDevicePolicy = (input: Pick<AppleDeviceConnection, "enabled" | "readPolicy" | "writePolicy" | "disabledProfileIds"> & { resource: AppleDeviceResource; expectedRevision: number }) => write<AppleDeviceStatus>("policy", input);
export const openAppleDeviceSettings = (resource: AppleDeviceResource) => write<{ opened: true }>("settings", { resource });

export function appleDeviceErrorKey(error: unknown): "conflict" | "unavailable" | "denied" | "failed" {
  const code = (error as { code?: unknown })?.code;
  if (typeof code !== "string") return "failed";
  if (code.includes("REVISION_CONFLICT")) return "conflict";
  if (code.includes("DENIED") || code.includes("RESTRICTED")) return "denied";
  if (code.includes("UNAVAILABLE") || code.includes("UNSUPPORTED")) return "unavailable";
  return "failed";
}
