import OpenCC from "opencc-js";
import type { RichMediaRef } from "../libs/ai.js";
import { isSupportedVideoUrl } from "../libs/video.js";

const SIMPLE_CASUAL_MESSAGE_REGEX =
  /^(?:在吗|在嘛|早|早安|晚安|午安|下午好|晚上好|哈哈+|哈+|草+|6+|666+|笑死|绷不住|确实|懂了|好耶|好哦|好喔|好吧|谢谢|谢啦|牛|可爱|可爱捏|什么鬼|啥|这啥|真的假的|啊\??|哦+|喵+|？+|\?+|!+|！+|嗯+|呜+|欸+|诶+)$/u;
const DETAILED_REQUEST_REGEX = /认真|详细|解释(?:一下|清楚|清楚点)?|展开讲|细说|具体说说|说详细点/u;
const REALTIME_REQUEST_REGEX =
  /最新|刚刚发生|实时(?:消息|资讯|信息|数据)?|新闻|版本(?:号)?|更新(?:了没|了吗|内容)?|价格|股价|汇率|天气|日期|几点|时间|几号|星期几|发布(?:了没|了吗|时间)?|官网/u;
const CURRENT_FACT_QUESTION_REGEX =
  /(?:现在(?:几点|几[号點]|是什么时间|幾點|幾號)|今天(?:几号|星期几|多少号|日期|天氣|天气)|(?:現在|今天).*(?:幾點|几點|幾號|几号|星期幾|星期几|天氣|天气))/u;
const TECHNICAL_SIGNAL_REGEX =
  /```|`[^`]+`|\b(?:api|sdk|json|sql|http|https|node|npm|pnpm|yarn|git|docker|typescript|javascript|python|java|rust|go|react|vue|astro|firebase|eslint|prettier|pm2|linux|nginx|redis)\b|(?:报错|报錯|错误|錯誤|异常|例外|堆栈|堆疊|代码|代碼|函数|函數|编译|編譯|语法|語法|类型|類型|接口|介面|实现|實現|性能|架构|原理|命令|脚本|日誌|日志|矩阵|矩陣|微积分|微積分|线代|線代|高数|高數|数学|數學|证明|證明|定理|极限|極限|导数|導數|积分|積分|概率|機率|統計|统计|traceback|exception|stack trace|tsconfig|package\.json|pnpm-lock|npm run|import |export |const |let |var |class )/iu;
const traditionalToSimplified = OpenCC.Converter({ from: "t", to: "cn" });

export interface LocalAiRoute {
  tier: "simple" | "complex" | "tech";
  needsSearch: boolean;
  preferAdvisor: boolean;
  allowPersistentTools: boolean;
  usedLocalRoute: true;
  reason: string;
}

function countSegments(text: string): number {
  return text
    .split(/[\n。！？!?]+/u)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

export function decideLocalAiRoute(params: {
  rawText: string;
  isMentioned: boolean;
  isRepliedToBot: boolean;
  urls: string[];
  mediaRefs: RichMediaRef[];
}): LocalAiRoute | null {
  const normalized = traditionalToSimplified(params.rawText).replace(/\s+/g, " ").trim();
  const currentMedia = params.mediaRefs.filter((media) => media.source === "current");
  const hasCurrentMedia = currentMedia.length > 0;
  const hasNonStickerMedia = currentMedia.some((media) => media.type !== "sticker");
  const hasUrls = params.urls.length > 0;
  const hasOnlyVideoUrls = hasUrls && params.urls.every(isSupportedVideoUrl);
  const needsSearch =
    (hasUrls && !hasOnlyVideoUrls) ||
    REALTIME_REQUEST_REGEX.test(normalized) ||
    CURRENT_FACT_QUESTION_REGEX.test(normalized);
  const isTriggered = params.isMentioned || params.isRepliedToBot;
  const route = (
    tier: LocalAiRoute["tier"],
    reason: string,
    preferAdvisor: boolean,
    allowPersistentTools: boolean,
  ): LocalAiRoute => ({
    tier,
    needsSearch,
    preferAdvisor,
    allowPersistentTools,
    usedLocalRoute: true,
    reason,
  });

  if (TECHNICAL_SIGNAL_REGEX.test(normalized)) return route("tech", "technical_signal", true, true);
  if (DETAILED_REQUEST_REGEX.test(normalized))
    return route("complex", "explicit_detailed_request", true, true);
  if (hasNonStickerMedia) return route("simple", "current_non_sticker_media_present", true, true);
  if (hasCurrentMedia && !hasUrls && normalized.length <= 16)
    return route("simple", "sticker_or_light_media_chat", false, false);
  if (isTriggered && hasOnlyVideoUrls && !needsSearch)
    return route("simple", "video_url_present", true, true);

  const sentences = countSegments(normalized);
  if (
    isTriggered &&
    !hasUrls &&
    !hasCurrentMedia &&
    normalized.length > 0 &&
    normalized.length <= 24 &&
    sentences <= 2
  ) {
    return route(
      "simple",
      SIMPLE_CASUAL_MESSAGE_REGEX.test(normalized)
        ? "short_casual_triggered_chat"
        : "short_triggered_chat",
      false,
      !SIMPLE_CASUAL_MESSAGE_REGEX.test(normalized),
    );
  }
  if (
    isTriggered &&
    !hasUrls &&
    !hasCurrentMedia &&
    normalized.length > 0 &&
    normalized.length <= 48 &&
    sentences <= 3
  )
    return route("simple", "medium_triggered_chat", false, true);
  if (needsSearch) return route("complex", "realtime_or_search_request", true, true);
  return null;
}
