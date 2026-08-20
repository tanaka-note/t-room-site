import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");

assert.match(source, /path === "\/api\/player\/media"/);
assert.match(source, /child\.password_hash IS NULL/);
assert.match(source, /file\.display_metadata_version = 0[\s\S]+COALESCE\(file\.display_media_kind, file\.media_kind\) IN \('audio', 'video'\)/);
assert.match(source, /LIMIT \? OFFSET \?/);
assert.match(source, /requireYouTubeApiKey\(env\)/);
assert.match(source, /env\.YOUTUBE_API_KEY/);
assert.match(source, /youtube\/v3\/videos/);
assert.match(source, /youtube\/v3\/search/);
assert.match(source, /6 \* 60 \* 60/);
assert.doesNotMatch(source, /yt-dlp|youtube-dl|videoplayback|googlevideo\.com/i);
assert.doesNotMatch(source, /YOUTUBE_API_KEY\s*=\s*["'][^"']+["']/);

console.log("Player media index and official YouTube API contract: ok");
