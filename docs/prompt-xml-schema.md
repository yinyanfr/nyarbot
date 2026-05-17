## Prompt XML Schema

This document defines the XML contract used by nyarbot prompts and dynamic context payloads.

### Goals

- Keep model inputs structurally explicit
- Reduce ambiguity between history vs current turn
- Prevent hallucinations around reply chains, URL fetch status, and trigger mode

### Top-Level Blocks

- `system_prompt`: main persona/rules prompt (`buildSystemPrompt`)
- `probe_system_prompt`: lightweight proactive probe prompt (`buildProbeSystemPrompt`)
- `late_binding`: per-turn dynamic hints (`buildLateBindingPrompt`)
- `recent_history`: serialized conversation buffer (`formatHistoryAsContext`)
- `current_turn`: structured current user message (`buildUserMessage`)

### `recent_history`

```xml
<recent_history order="oldest_to_newest">
  <message uid="10001" name="小明" username="xiaoming" ts="1715850000000">...</message>
</recent_history>
```

Rules:

- `message` entries are historical context only
- Do not treat repeated wording in history and current turn as automatic duplicate-send evidence

### `current_turn`

```xml
<current_turn>
  <speaker name="小明" />
  <trigger mode="passive_triggered" mentioned="true" replied_to_bot="false" />
  <reply_to uid="10002" name="阿宅 (@otaku)">
    <quoted_text>...</quoted_text>
    <note>reply_to 内容是被回复消息，不是当前说话人的新消息</note>
  </reply_to>
  <text>...</text>
  <media>...</media>
  <links>...</links>
</current_turn>
```

Rules:

- `current_turn` is the primary message to respond to
- `reply_to/quoted_text` is referenced previous content, not new utterance

### `trigger`

Fields:

- `mode`: `passive_triggered` | `not_triggered`
- `mentioned`: `true` | `false`
- `replied_to_bot`: `true` | `false`

Semantics:

- `passive_triggered` means user explicitly @mentioned/replied and bot should prioritize direct response behavior

### `links/link`

```xml
<links>
  <link url="https://example.com" status="success">
    <summary>...</summary>
  </link>
  <link url="https://example.org" status="failed">
    <error>无法获取内容</error>
  </link>
</links>
```

Rules:

- `status="success"`: URL content is available; reply should use summary
- `status="failed"`: URL fetch failed; model may say it cannot access content

### `media`

Possible children:

- `image`
- `sticker`
- `media_item` (for video/gif/video_note/document/audio thumbnail descriptors)

Examples:

```xml
<media>
  <image><description>...</description></image>
  <sticker><emoji>😭</emoji></sticker>
  <media_item label="视频" thumbnail_only="true"><description>...</description></media_item>
</media>
```

Rules:

- `thumbnail_only="true"` means descriptor is from preview thumbnail/cover, not full media content

### XML Escaping

All dynamic values must be XML-escaped before interpolation:

- `& -> &amp;`
- `< -> &lt;`
- `> -> &gt;`
- `" -> &quot;`
- `' -> &apos;`

### Naming Convention

- Use `snake_case` for tag names and attribute names
- Use explicit status enums where possible (`success`/`failed`, `true`/`false`)
- Keep free-form explanatory text in dedicated text nodes like `<note>`

### Backward Compatibility

- Prompt parsing is model-side (not strict XML parser), so schema updates should be additive where possible
- If changing existing tags/attributes, update this file and relevant prompt builders together
