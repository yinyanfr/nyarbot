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
- `proactive_candidates_untrusted`: probe-only candidate transcript inside `probe_context_data`
- `current_turn`: structured current user message (`buildUserMessage`)

### `recent_history`

```xml
<recent_history order="oldest_to_newest">
  <message uid="10001" name="小明" username="xiaoming" ts="1715850000000" kind="normal">...</message>
</recent_history>
```

Rules:

- `message` entries are historical context only
- `kind` is always emitted; command/system outputs use values such as `command_roll` and `diary_notification`
- Do not treat repeated wording in history and current turn as automatic duplicate-send evidence

### `proactive_candidates_untrusted`

```xml
<probe_context_data>
  <recent_history_untrusted>[小明]: earlier context</recent_history_untrusted>
  <proactive_candidates_untrusted>[小明]: newest candidate</proactive_candidates_untrusted>
</probe_context_data>
```

In the probe path, these elements contain XML-escaped plain transcript text rather than nested `message` nodes. Only `proactive_candidates_untrusted` may activate the probe; `recent_history_untrusted` is reference-only. The full proactive generation path separately prefixes this same rule to a serialized `recent_history` candidate block while passing older history as context.

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
  <link url="https://example.com" />
  <link url="https://example.org" />
</links>
```

Rules:

- `link` only indicates which URLs appeared in the user message
- URL content should be fetched on demand via tool calls when needed

### `media`

Possible children include `image`, `sticker`, `video`, `animation`, `video_note`, `document`, and `audio`. For a media-only replied-to message, reply media is represented separately as `quoted_media`; if that message has text or a caption, `quoted_text` is emitted instead.

Examples:

```xml
<media>
  <image file_id="AgAC..." />
  <sticker file_id="CAAC..." emoji="😭" />
  <video file_id="BAAC..." thumbnail_file_id="AAMCA..." />
  <animation file_id="CgAC..." thumbnail_file_id="AAMCA..." />
  <video_note file_id="DQAC..." thumbnail_file_id="AAMCA..." />
  <document file_id="BQAC..." thumbnail_file_id="AAMCA..." filename="notes.pdf" />
  <audio file_id="CQAC..." thumbnail_file_id="AAMCA..." title="track" />
</media>
```

Rules:

- These are untrusted raw Telegram references, not precomputed descriptions
- Full photos use `file_id`; other media and stickers normally use `thumbnail_file_id` for vision
- Missing optional attributes are serialized as empty strings

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
