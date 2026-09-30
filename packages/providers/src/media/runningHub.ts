const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off", placeholder: "RunningHub 控制台个人中心获取的 32 位 API Key" },
  },
  {
    type: "input",
    field: "baseUrl" as const,
    title: "站点地址",
    value: "https://www.runninghub.cn",
    props: { placeholder: "https://www.runninghub.cn 或 https://www.runninghub.ai" },
  },
  {
    type: "select",
    field: "taskKind" as const,
    title: "任务类型",
    value: "workflow",
    options: [
      { label: "ComfyUI 工作流", value: "workflow" },
      { label: "AI 应用", value: "aiapp" },
    ],
  },
  {
    type: "select",
    field: "instanceType" as const,
    title: "算力机型",
    value: "default",
    options: [
      { label: "默认 (24G 显存)", value: "default" },
      { label: "Plus (48G 显存)", value: "plus" },
    ],
  },
  {
    type: "input",
    field: "imageWorkflowId" as const,
    title: "图片工作流 ID",
    value: "",
    props: { placeholder: "工作流编辑页 URL 中 workflowId= 后的数字；AI 应用填 webappId= 后的数字" },
  },
  {
    type: "input",
    field: "videoWorkflowId" as const,
    title: "视频工作流 ID",
    value: "",
    props: { placeholder: "同上，视频工作流 / AI 应用 ID" },
  },
  {
    type: "input",
    field: "imageNodeMap" as const,
    title: "图片节点映射 (JSON)",
    value: '{\n  "prompt": { "nodeId": "6", "fieldName": "text" },\n  "image": { "nodeId": "10", "fieldName": "image" },\n  "width": { "nodeId": "5", "fieldName": "width" },\n  "height": { "nodeId": "5", "fieldName": "height" },\n  "seed": { "nodeId": "3", "fieldName": "seed" }\n}',
    props: { type: "textarea", rows: 9, placeholder: '如 {"prompt": {"nodeId": "6", "fieldName": "text"}}' },
  },
  {
    type: "input",
    field: "videoNodeMap" as const,
    title: "视频节点映射 (JSON)",
    value: '{\n  "prompt": { "nodeId": "6", "fieldName": "text" },\n  "image": { "nodeId": "10", "fieldName": "image" },\n  "duration": { "nodeId": "20", "fieldName": "value", "unit": "seconds" },\n  "seed": { "nodeId": "3", "fieldName": "seed" }\n}',
    props: { type: "textarea", rows: 9, placeholder: '如 {"prompt": {"nodeId": "6", "fieldName": "text"}}' },
  },
] as const;

const version = "2.0.0";

interface NodeMapping {
  nodeId: string;
  fieldName: string;
  /** 固定值：非动态逻辑名写了 value 会作为常量注入。 */
  value?: string;
  /** duration 换算单位：seconds（默认）或 frames。 */
  unit?: string;
  /** unit 为 frames 时的帧率，默认 24。 */
  fps?: number;
}

interface NodeInfo {
  nodeId: string;
  fieldName: string;
  fieldValue: string;
}

/** 动态逻辑名：由请求内容填充；其他带 value 的条目按常量注入。 */
const DYNAMIC_KEYS = new Set([
  "prompt", "negative", "image", "image2", "image3", "video", "audio",
  "mask", "firstFrame", "lastFrame", "width", "height", "seed", "steps", "cfg", "duration",
]);

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function otherOf(request: ImageRequest | VideoRequest): Record<string, unknown> {
  const other = (request as { other?: unknown }).other;
  return other && typeof other === "object" && !Array.isArray(other) ? (other as Record<string, unknown>) : {};
}

function parseNodeMap(raw: unknown, title: string): Record<string, NodeMapping> {
  const text = str(raw).trim();
  if (!text) throw new Error(`${title}未配置，请按说明填写节点映射 JSON`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${title}不是合法 JSON，请检查括号和引号`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${title}须为 JSON 对象`);
  const result: Record<string, NodeMapping> = {};
  for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${title}中 "${key}" 格式错误，须为 { nodeId, fieldName }`);
    const mapping = item as Record<string, unknown>;
    const nodeId = str(mapping.nodeId).trim();
    const fieldName = str(mapping.fieldName).trim();
    if (!nodeId || !fieldName) throw new Error(`${title}中 "${key}" 缺少 nodeId 或 fieldName`);
    const entry: NodeMapping = { nodeId, fieldName };
    if (mapping.value !== undefined) entry.value = str(mapping.value);
    if (mapping.unit !== undefined) entry.unit = str(mapping.unit);
    if (mapping.fps !== undefined && Number(mapping.fps) > 0) entry.fps = Number(mapping.fps);
    result[key] = entry;
  }
  return result;
}

function wait(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

const mimeExt: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

async function mediaBytes(context: ProviderContext, input: MediaInput): Promise<{ data: Uint8Array; mimeType: string }> {
  if (input.type === "binary") return { data: input.data, mimeType: input.mimeType || "application/octet-stream" };
  if (input.type === "base64") return { data: Buffer.from(input.data, "base64"), mimeType: input.mimeType };
  const response = await context.tool.fetch(input.url, { signal: context.signal });
  if (!response.ok) throw new Error(`参考媒体下载失败（HTTP ${response.status}）`);
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || input.mimeType || "application/octet-stream";
  return { data: new Uint8Array(await response.arrayBuffer()), mimeType };
}

/** 上传参考媒体到 RunningHub，返回可填入 nodeInfoList 的 fileName。 */
async function uploadFile(
  context: ProviderContext,
  host: string,
  apiKey: string,
  input: MediaInput,
  name: string,
  signal: AbortSignal,
): Promise<string> {
  const { data, mimeType } = await mediaBytes(context, input);
  const ext = mimeExt[mimeType.toLowerCase()] || "bin";
  const boundary = `----RunningHub${Date.now().toString(16)}${Math.floor(Math.random() * 0xffffff).toString(16)}`;
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}.${ext}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, Buffer.from(data), footer]);
  const response = await context.tool.fetch(`${host}/openapi/v2/media/upload/binary`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    signal,
  });
  if (!response.ok) throw new Error(`上传参考媒体到 RunningHub 失败（HTTP ${response.status}）`);
  const result = await response.json();
  const fileName = result?.data?.fileName ?? result?.fileName;
  if (typeof fileName !== "string" || !fileName.trim()) throw new Error("RunningHub 未返回上传文件名");
  return fileName.trim();
}

/** 尺寸档位 + 比例换算像素（8 的倍数），如 2K + 16:9 → 2048x1152。 */
function sizeToPixels(size: string | undefined, ratio: string | undefined): { width: number; height: number } {
  const text = (size || "").toUpperCase().replace(/\s+/g, "");
  const wh = /^(\d+)[X*×](\d+)$/.exec(text);
  const k = /^(\d+(?:\.\d+)?)K$/.exec(text);
  const longEdge = wh ? Math.max(Number(wh[1]), Number(wh[2])) : k ? Math.round(Number(k[1]) * 1024) : 2048;
  const match = /^(\d+)\s*[:：]\s*(\d+)$/.exec((ratio || "1:1").trim());
  const a = match ? Number(match[1]) : 1;
  const b = match ? Number(match[2]) : 1;
  const maxSide = Math.max(a, b) || 1;
  const round8 = (value: number) => Math.max(8, Math.round(value / 8) * 8);
  return { width: round8((longEdge * a) / maxSide), height: round8((longEdge * b) / maxSide) };
}

async function submitTask(
  context: ProviderContext,
  host: string,
  apiKey: string,
  taskKind: string,
  workflowId: string,
  nodeInfoList: NodeInfo[],
  instanceType: string,
  signal: AbortSignal,
): Promise<string> {
  const isAiApp = taskKind === "aiapp";
  const path = isAiApp ? "/task/openapi/ai-app/run" : "/task/openapi/create";
  const body = isAiApp
    ? { apiKey, webappId: workflowId, nodeInfoList, instanceType }
    : { apiKey, workflowId, nodeInfoList, instanceType };
  const response = await context.tool.fetch(`${host}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`提交 RunningHub 任务失败（HTTP ${response.status}）`);
  const result = await response.json();
  if (result && typeof result === "object" && result.code !== undefined && result.code !== 0) {
    throw new Error(context.tool.errorMessage?.(result) || `提交任务失败（code ${result.code}）`);
  }
  const tipsRaw = result?.data?.promptTips;
  if (typeof tipsRaw === "string" && tipsRaw.includes('"result":false')) {
    throw new Error(`RunningHub 工作流校验失败：${tipsRaw.slice(0, 500)}`);
  }
  const taskId = result?.data?.taskId;
  if (typeof taskId !== "string" || !taskId.trim()) throw new Error("RunningHub 未返回任务 ID");
  return taskId.trim();
}

async function pollTask(
  context: ProviderContext,
  host: string,
  apiKey: string,
  taskId: string,
  mediaType: "image" | "video",
  signal: AbortSignal,
): Promise<MediaAsset[]> {
  while (true) {
    const response = await context.tool.fetch(`${host}/openapi/v2/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ taskId }),
      signal,
    });
    if (!response.ok) throw new Error(`查询 RunningHub 任务失败（HTTP ${response.status}）`);
    const result = await response.json();
    const status = String(result?.status || "").toUpperCase();
    if (status === "SUCCESS") {
      const results = Array.isArray(result?.results) ? result.results : [];
      const assets: MediaAsset[] = [];
      for (const item of results) {
        const url = typeof item?.url === "string" ? item.url.trim() : "";
        if (url) assets.push({ mediaType, type: "url", url });
      }
      if (!assets.length) throw new Error("RunningHub 任务成功但未返回媒体地址");
      return assets;
    }
    if (status === "FAILED" || status === "CANCELLED" || status === "CANCELED") {
      throw new Error(
        context.tool.errorMessage?.(result) || str(result?.failedReason) || str(result?.errorMessage) || "RunningHub 任务失败",
      );
    }
    await wait(signal, 5000);
  }
}

async function runWorkflow(
  this: ProviderContext<ProviderConfig<typeof rules>>,
  request: ImageRequest | VideoRequest,
  mediaType: "image" | "video",
): Promise<MediaAsset[]> {
  const apiKey = str(this.config.apiKey).trim();
  if (!apiKey) throw new Error("请先在供应商配置中填写 RunningHub API Key");
  const host = str(this.config.baseUrl).trim().replace(/\/$/, "") || "https://www.runninghub.cn";
  const taskKind = str(this.config.taskKind).trim() || "workflow";
  const instanceType = str(this.config.instanceType).trim() || "default";
  const other = otherOf(request);
  const configuredId = mediaType === "image" ? str(this.config.imageWorkflowId).trim() : str(this.config.videoWorkflowId).trim();
  const workflowId = str(other.workflowId).trim() || configuredId;
  if (!workflowId) throw new Error(mediaType === "image" ? "请先配置图片工作流 ID" : "请先配置视频工作流 ID");
  const nodeMap = parseNodeMap(
    mediaType === "image" ? this.config.imageNodeMap : this.config.videoNodeMap,
    mediaType === "image" ? "图片节点映射" : "视频节点映射",
  );

  // ACT: 图片最多等待 15 分钟，视频 30 分钟。
  const signal = AbortSignal.any([AbortSignal.timeout((mediaType === "image" ? 15 : 30) * 60_000), ...(this.signal ? [this.signal] : [])]);
  const nodeInfoList: NodeInfo[] = [];
  const push = (key: string, fieldValue: string) => {
    const mapping = nodeMap[key];
    if (mapping) nodeInfoList.push({ nodeId: mapping.nodeId, fieldName: mapping.fieldName, fieldValue });
  };

  const promptMapping = nodeMap.prompt;
  if (!promptMapping) throw new Error("节点映射缺少 prompt（提示词节点），请先配置");
  nodeInfoList.push({ nodeId: promptMapping.nodeId, fieldName: promptMapping.fieldName, fieldValue: request.prompt });

  // 常量注入：非动态逻辑名 + 写了 value 的条目。
  for (const [key, mapping] of Object.entries(nodeMap)) {
    if (!DYNAMIC_KEYS.has(key) && mapping.value !== undefined) {
      nodeInfoList.push({ nodeId: mapping.nodeId, fieldName: mapping.fieldName, fieldValue: mapping.value });
    }
  }

  const negative = str(other.negative).trim();
  if (negative) push("negative", negative);

  const videoRequest = request as VideoRequest;
  const imageRequest = request as ImageRequest;
  const images = imageRequest.images ?? [];
  const primary = videoRequest.firstFrame ?? images[0];
  if (primary && nodeMap.image) {
    push("image", await uploadFile(this, host, apiKey, primary, "input", signal));
  }
  for (let index = 1; index < images.length; index++) {
    const key = `image${index + 1}`;
    if (nodeMap[key]) push(key, await uploadFile(this, host, apiKey, images[index], `input${index + 1}`, signal));
  }
  const lastFrame = videoRequest.lastFrame;
  const lastMapping = nodeMap.lastFrame ?? nodeMap.image2;
  if (lastFrame && lastMapping && !images[1]) {
    nodeInfoList.push({
      nodeId: lastMapping.nodeId,
      fieldName: lastMapping.fieldName,
      fieldValue: await uploadFile(this, host, apiKey, lastFrame, "input-last", signal),
    });
  }
  const videos = videoRequest.videos ?? [];
  if (videos[0] && nodeMap.video) push("video", await uploadFile(this, host, apiKey, videos[0], "input-video", signal));
  const audios = videoRequest.audios ?? [];
  if (audios[0] && nodeMap.audio) push("audio", await uploadFile(this, host, apiKey, audios[0], "input-audio", signal));
  if (imageRequest.mask && nodeMap.mask) push("mask", await uploadFile(this, host, apiKey, imageRequest.mask, "input-mask", signal));

  if (nodeMap.width && nodeMap.height) {
    const pixels = sizeToPixels(imageRequest.size, request.ratio);
    nodeInfoList.push({ nodeId: nodeMap.width.nodeId, fieldName: nodeMap.width.fieldName, fieldValue: String(pixels.width) });
    nodeInfoList.push({ nodeId: nodeMap.height.nodeId, fieldName: nodeMap.height.fieldName, fieldValue: String(pixels.height) });
  }
  if (nodeMap.seed) {
    const seed = other.seed !== undefined ? str(other.seed) : String(Math.floor(Math.random() * 2 ** 31));
    push("seed", seed);
  }
  if (mediaType === "video" && nodeMap.duration && videoRequest.duration) {
    const durationMapping = nodeMap.duration;
    const fieldValue =
      durationMapping.unit === "frames"
        ? String(Math.round(videoRequest.duration * (durationMapping.fps || Number(other.fps) || 24)))
        : String(videoRequest.duration);
    nodeInfoList.push({ nodeId: durationMapping.nodeId, fieldName: durationMapping.fieldName, fieldValue });
  }

  const extra = other.nodeInfoList;
  if (Array.isArray(extra)) {
    for (const item of extra) {
      if (item && typeof item === "object") {
        const entry = item as Record<string, unknown>;
        const nodeId = str(entry.nodeId).trim();
        const fieldName = str(entry.fieldName).trim();
        if (nodeId && fieldName) nodeInfoList.push({ nodeId, fieldName, fieldValue: str(entry.fieldValue) });
      }
    }
  }

  const taskId = await submitTask(this, host, apiKey, taskKind, workflowId, nodeInfoList, instanceType, signal);
  return pollTask(this, host, apiKey, taskId, mediaType, signal);
}

async function generateImage(
  this: ProviderContext<ProviderConfig<typeof rules>>,
  request: ImageRequest,
): Promise<MediaAsset[]> {
  return runWorkflow.call(this, request, "image");
}

async function generateVideo(
  this: ProviderContext<ProviderConfig<typeof rules>>,
  request: VideoRequest,
): Promise<MediaAsset[]> {
  return runWorkflow.call(this, request, "video");
}

export default {
  id: "runningHub",
  label: "RunningHub",
  version,
  readme: `## RunningHub 自定义供应商

把 Toonflow 的图片 / 视频生成接到你自己在 RunningHub 上的工作流（ComfyUI 工作流或 AI 应用）。

### 配置步骤

1. **API Key**：RunningHub 控制台 → 个人中心 → API Key（32 位），粘贴到上方配置中。
2. **站点地址**：国内用 \`https://www.runninghub.cn\`，国际用 \`https://www.runninghub.ai\`。
3. **任务类型**：发布的是 ComfyUI 工作流选「ComfyUI 工作流」，是 AI 应用选「AI 应用」。
4. **工作流 ID**：
   - ComfyUI 工作流：打开工作流编辑页，URL 里 \`workflowId=\` 后面的数字；
   - AI 应用：打开应用页面，URL 里 \`webappId=\` 后面的数字。
5. **节点映射 (JSON)**：告诉本供应商把提示词、参考图等填到你工作流的哪个节点。
   - ComfyUI 工作流：编辑页右上角「获取节点ID」复制节点编号，字段名就是节点输入框的名字（如 \`text\`、\`image\`、\`width\`）；
   - AI 应用：应用页「API 调用示例」里有完整的 nodeInfoList，直接照抄 nodeId 和 fieldName。

### 节点映射写法

\`\`\`json
{
  "prompt":   { "nodeId": "6",  "fieldName": "text" },
  "negative": { "nodeId": "7",  "fieldName": "text" },
  "image":    { "nodeId": "10", "fieldName": "image" },
  "width":    { "nodeId": "5",  "fieldName": "width" },
  "height":   { "nodeId": "5",  "fieldName": "height" },
  "seed":     { "nodeId": "3",  "fieldName": "seed" },
  "duration": { "nodeId": "20", "fieldName": "value", "unit": "seconds" }
}
\`\`\`

- 逻辑名是固定的：\`prompt\`（必填）、\`negative\`、\`image\`（首帧 / 参考图 1）、\`image2\` / \`image3\`（更多参考图）、\`lastFrame\`（尾帧）、\`video\`、\`audio\`、\`mask\`、\`width\`、\`height\`、\`seed\`（每次随机）、\`steps\`、\`cfg\`、\`duration\`。
- 参考图 / 视频 / 音频会自动上传到 RunningHub 后填入对应节点。
- \`width\` + \`height\` 同时配置时，按 Toonflow 选择的画布比例与尺寸（如 16:9、2K）自动换算像素（8 的倍数）。
- \`duration\` 给视频时长：\`unit\` 为 \`seconds\` 直接填秒数，为 \`frames\` 则按 \`fps\`（默认 24）换算成帧数。
- 不在上面列表、但写了 \`"value": "固定值"\` 的条目会作为常量注入，例如：\`"steps": { "nodeId": "3", "fieldName": "steps", "value": "20" }\`。

### 费用与限制

- 任务按你的 RunningHub 账户计费（RH 币 / 会员），与 Toonflow 无关。
- 图片单次最多等待 15 分钟，视频 30 分钟；超时或失败会直接报错，可重试。
- 生成数量、画质上限由你的工作流本身决定。`,
  rules,
  models: [
    {
      id: "runninghub-image",
      label: "RunningHub 图片工作流",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "1.5K", "2K", "4K"],
      imageRatios: ["1:1", "3:4", "4:3", "9:16", "16:9", "3:2", "2:3", "21:9"],
    },
    {
      id: "runninghub-video",
      label: "RunningHub 视频工作流",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [2, 3, 4, 5, 6, 8, 10], resolution: ["720p", "1080p"] }],
    },
  ] satisfies ProviderModel[],
  generateImage,
  generateVideo,
} satisfies ProviderDefinition<typeof rules>;
