const assert = require("node:assert/strict");
const { waitFor } = require("./extension-test-helpers.cjs");

// Served on the production origin. Only the page/player boundary is synthetic;
// the packaged extension, Chrome messaging, worker, and API fetch remain real.
const HTML = `<!doctype html><html><head><title>YouTube subtitle fixture</title>
<style>
body{margin:0;background:#181818;color:white;font:16px Arial}main{padding:32px}
#movie_player{position:relative;width:1120px;height:630px;background:#242424}
video{width:100%;height:100%}.ytp-chrome-bottom{position:absolute;bottom:0;width:100%;height:48px}
.ytp-right-controls{float:right;display:flex;height:48px}.ytp-button{width:48px;height:48px;background:transparent;color:white;border:0}
</style></head><body><main><h1>Packaged subtitle recovery fixture</h1>
<div id="movie_player" class="html5-video-player"><video></video>
<div id="ytp-caption-window-container"></div><div class="ytp-chrome-bottom"><div class="ytp-right-controls">
<button class="ytp-subtitles-button ytp-button" aria-pressed="false">CC</button>
</div></div></div></main><script>
window.__fixtureInstallVideo = function(video) {
  let paused = true;
  const time = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
  const rate = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
  time.set.call(video, 1);
  Object.defineProperties(video, {
    currentTime: {configurable:true,get:()=>time.get.call(video),set:value=>{time.set.call(video, Number(value));video.dispatchEvent(new Event('seeking'));}},
    playbackRate: {configurable:true,get:()=>rate.get.call(video),set:value=>rate.set.call(video, Number(value))},
    paused: {configurable:true,get:()=>paused},
    duration: {configurable:true,get:()=>1800},
    readyState: {configurable:true,get:()=>4},
    play: {configurable:true,value:async()=>{paused=false;video.dispatchEvent(new Event('play'));video.dispatchEvent(new Event('playing'));}},
    pause: {configurable:true,value:()=>{paused=true;video.dispatchEvent(new Event('pause'));}},
    advanceTime: {configurable:true,value:value=>{time.set.call(video, Number(value));video.dispatchEvent(new Event('timeupdate'));}}
  });
};
window.__fixtureInstallVideo(document.querySelector('video'));
const player = document.querySelector('#movie_player');
player.getVideoData = () => ({video_id:new URLSearchParams(location.search).get('v')});
player.getPlayerResponse = () => window.ytInitialPlayerResponse;
player.getOption = (group,key) => key === 'tracklist'
  ? window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []
  : window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.[0];
player.setOption = () => document.querySelector('.ytp-subtitles-button').setAttribute('aria-pressed','true');
player.loadModule = () => {};
document.querySelector('.ytp-subtitles-button').onclick = event => event.currentTarget.setAttribute('aria-pressed','true');
</script></body></html>`;

async function routeYoutubeFixture(context) {
	await context.route("https://www.youtube.com/watch?**", (route) => {
		const videoId = new URL(route.request().url()).searchParams.get("v") || "";
		if (videoId === "subtitle-regression" || videoId.startsWith("recovery")) {
			return route.fulfill({
				status: 200,
				contentType: "text/html",
				body: HTML,
			});
		}
		return route.fallback();
	});
}

async function observeContentMessages(context, page, extensionId) {
	const session = await context.newCDPSession(page);
	const contexts = [];
	session.on("Runtime.executionContextCreated", ({ context }) =>
		contexts.push(context),
	);
	await session.send("Runtime.enable");
	const world = await waitFor(
		() =>
			contexts.find(
				(context) =>
					context.origin === `chrome-extension://${extensionId}` ||
					context.name === extensionId,
			),
		{ timeoutMessage: "The packaged content-script world was not found." },
	);
	async function evaluate(fn, arg) {
		const result = await session.send("Runtime.evaluate", {
			contextId: world.id,
			expression: `(${fn.toString()})(${JSON.stringify(arg) ?? "undefined"})`,
			awaitPromise: true,
			returnByValue: true,
		});
		assert.equal(
			result.exceptionDetails,
			undefined,
			JSON.stringify(result.exceptionDetails),
		);
		return result.result.value;
	}
	await evaluate(() => {
		globalThis.__e2eMessages = [];
		const original = chrome.runtime.sendMessage.bind(chrome.runtime);
		chrome.runtime.sendMessage = async (message) => {
			const entry = { message, at: Date.now() };
			globalThis.__e2eMessages.push(entry);
			if (
				globalThis.__e2eRejectRecovery &&
				message.type === "start-youtube-subtitle-translation"
			) {
				entry.response = { ok: false, error: "Injected recovery failure" };
				return entry.response;
			}
			const response = await original(message);
			entry.response = response;
			if (
				message.type === "start-youtube-subtitle-translation" &&
				globalThis.__e2eRecoveryDelay
			) {
				await new Promise((resolve) =>
					setTimeout(resolve, globalThis.__e2eRecoveryDelay),
				);
			}
			return response;
		};
	});
	return {
		evaluate,
		messages: () => evaluate(() => globalThis.__e2eMessages),
		close: () => session.detach(),
	};
}

async function createWorkerStopper(context, page, extensionId) {
	const session = await context.newCDPSession(page);
	let current;
	const events = [];
	session.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
		for (const version of versions) {
			if (version.scriptURL.startsWith(`chrome-extension://${extensionId}/`)) {
				current = version;
				events.push(version);
			}
		}
	});
	await session.send("ServiceWorker.enable");
	return {
		async stop() {
			await waitFor(() => current?.runningStatus === "running");
			const marker = `${Date.now()}-${Math.random()}`;
			await context
				.serviceWorkers()
				.at(-1)
				.evaluate((value) => {
					globalThis.__e2eWorkerMarker = value;
				}, marker);
			const from = events.length;
			await session.send("ServiceWorker.stopWorker", {
				versionId: current.versionId,
			});
			await waitFor(
				() =>
					events.slice(from).some((event) => event.runningStatus === "stopped"),
				{
					timeoutMessage:
						"Chrome did not report an actual stopped service worker.",
				},
			);
			return async () => {
				await waitFor(() =>
					events.slice(from).some((event) => event.runningStatus === "running"),
				);
				assert.equal(
					await context
						.serviceWorkers()
						.at(-1)
						.evaluate(() => globalThis.__e2eWorkerMarker),
					undefined,
					"A restarted worker must not retain the old JavaScript heap.",
				);
			};
		},
		close: () => session.detach(),
	};
}

module.exports = {
	routeYoutubeFixture,
	observeContentMessages,
	createWorkerStopper,
};
