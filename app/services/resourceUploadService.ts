/**
 * Resource Upload Service
 *
 * Uploads locally-stored images to the server during sync.
 * Images are saved to the device's document directory when taken/selected.
 * Their local paths live in event form_data until this service runs, at which
 * point each path is uploaded and replaced with the server-assigned resource ID.
 */

import * as FileSystem from "expo-file-system/legacy"
import * as SecureStore from "expo-secure-store"
import { Q } from "@nozbe/watermelondb"
import Toast from "react-native-root-toast"

import database from "@/db"
import EventModel from "@/db/model/Event"
import Peer from "@/models/Peer"

// ── Queued toast helper ──────────────────────────────────────────────────────
// Shows toasts one at a time so they never overlap and each one is readable
// before the next appears. Each toast lasts 2 s; the next starts 2.1 s later.
const _queue: string[] = []
let _toastActive = false

function _flush() {
  if (_toastActive || _queue.length === 0) return
  _toastActive = true
  const msg = _queue.shift()!
  Toast.show(`[Upload] ${msg}`, {
    duration: 2000,
    position: Toast.positions.TOP,
    containerStyle: { marginTop: 60 },
  })
  setTimeout(() => {
    _toastActive = false
    _flush()
  }, 2100)
}

const toast = (msg: string) => {
  console.log(`[ResourceUpload] ${msg}`)
  _queue.push(msg)
  _flush()
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when the value is a device URI from the image picker (not a server UUID).
 * Picker URIs are content:// (Android) or file:// (iOS/cache).
 */
export const isLocalFilePath = (value: unknown): value is string =>
  typeof value === "string" &&
  (value.startsWith("file://") ||
    value.startsWith("content://") ||
    value.startsWith(FileSystem.documentDirectory ?? "__never__"))

/**
 * Scans all events for file fields that still hold a local path, uploads each
 * file to the server, and updates the WatermelonDB record with the server UUID.
 * Called automatically before each sync. Failures are non-fatal — the local
 * path is kept so the next sync retries.
 */
export const uploadPendingResources = async (): Promise<void> => {
  const authHeader = await buildAuthHeader()
  if (!authHeader) {
    toast("No auth — skipping image upload")
    return
  }

  const apiUrl = await Peer.getActiveUrl()
  if (!apiUrl) {
    toast("No server URL — skipping image upload")
    return
  }

  toast(`Auth OK | ${apiUrl}`)

  const events = await database
    .get<EventModel>("events")
    .query(Q.where("is_deleted", false))
    .fetch()

  let pendingCount = 0
  for (const event of events) {
    const fd = event.formData
    if (Array.isArray(fd) && fd.some((i: any) => i.inputType === "file" && isLocalFilePath(i.value)))
      pendingCount++
  }

  toast(`${pendingCount} event(s) with local images to upload`)
  if (pendingCount === 0) return

  for (const event of events) {
    const formData = event.formData
    if (!Array.isArray(formData) || formData.length === 0) continue

    let needsUpdate = false

    const updatedFormData = await Promise.all(
      formData.map(async (item: any) => {
        if (item.inputType !== "file" || !isLocalFilePath(item.value)) return item

        const localPath: string = item.value
        const shortName = localPath.split("/").pop() ?? localPath

        try {
          // Only use getInfoAsync for file:// URIs — content:// picker URIs
          // don't map to a physical path that FileSystem can stat, but they
          // are still valid and readable by React Native's networking layer.
          if (localPath.startsWith("file://")) {
            const info = await FileSystem.getInfoAsync(localPath)
            if (!info.exists) {
              toast(`MISSING on disk: ${shortName}`)
              return item
            }
          }

          toast(`Uploading ${shortName}`)

          const resourceId = await uploadFile(localPath, authHeader, apiUrl)
          toast(`OK → ${resourceId.substring(0, 12)}...`)
          needsUpdate = true
          return { ...item, value: resourceId }
        } catch (err) {
          toast(`FAILED: ${String(err).substring(0, 120)}`)
          return item
        }
      }),
    )

    if (needsUpdate) {
      await database.write(async () => {
        await event.update((record) => {
          record.formData = updatedFormData
        })
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildAuthHeader(): Promise<string> {
  const token = await SecureStore.getItemAsync("provider_token")
  if (token) return `Bearer ${token}`
  const email = await SecureStore.getItemAsync("provider_email")
  const password = await SecureStore.getItemAsync("provider_password")
  if (email && password) return `Basic ${btoa(`${email}:${password}`)}`
  return ""
}

function mimeTypeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase()
  if (ext === "png") return "image/png"
  if (ext === "gif") return "image/gif"
  if (ext === "webp") return "image/webp"
  return "image/jpeg"
}

async function uploadFile(pickerUri: string, authHeader: string, apiUrl: string): Promise<string> {
  const mimeType = mimeTypeFromPath(pickerUri)
  const url = `${apiUrl}/api/forms/resources`
  const filename = pickerUri.split("/").pop() ?? "image.jpg"

  const isContent = pickerUri.startsWith("content://")
  toast(`URI type: ${isContent ? "content://" : "file://"} | ${pickerUri.substring(0, 50)}`)

  if (isContent) {
    // ── content:// path (library picker on Android) ───────────────────────
    // OkHttp can read content:// media URIs via ContentResolver.
    // Use the original FormData { uri, type, name } approach — this is what
    // worked before and is the standard React Native file-upload pattern.
    toast(`Using FormData (content:// URI)...`)
    const formData = new FormData()
    formData.append("file", { uri: pickerUri, type: mimeType, name: filename } as any)

    toast(`POSTing...`)
    const response = await fetch(url, {
      method: "POST",
      body: formData,
      headers: { Authorization: authHeader },
    })

    toast(`HTTP ${response.status}`)
    if (!response.ok) {
      const text = await response.text()
      toast(`Err: ${text.substring(0, 80)}`)
      throw new Error(`HTTP ${response.status}: ${text.substring(0, 200)}`)
    }

    const data = await response.json()
    toast(`Response: ${JSON.stringify(data).substring(0, 80)}`)
    if (!data.id) throw new Error(`No id in response: ${JSON.stringify(data)}`)
    return data.id
  } else {
    // ── file:// path (camera capture on Android / iOS) ────────────────────
    // OkHttp cannot read internal file:// URIs via FormData in New Architecture.
    // Use FileSystem.uploadAsync which reads the file natively.
    toast(`Using FileSystem.uploadAsync (file:// URI)...`)
    const result = await FileSystem.uploadAsync(url, pickerUri, {
      httpMethod: "POST",
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: "file",
      mimeType,
      headers: { Authorization: authHeader },
    })

    toast(`HTTP ${result.status}`)
    if (result.status < 200 || result.status >= 300) {
      toast(`Err: ${result.body.substring(0, 80)}`)
      throw new Error(`HTTP ${result.status}: ${result.body.substring(0, 200)}`)
    }

    const data = JSON.parse(result.body)
    toast(`Response: ${JSON.stringify(data).substring(0, 80)}`)
    if (!data.id) throw new Error(`No id in response: ${result.body}`)
    return data.id
  }
}
