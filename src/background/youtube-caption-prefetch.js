import * as TimedCaptions from "../content/youtube/timed-captions.js";
import { waitForAbortable } from "../shared/abort.js";

function isTrustedYoutubeCaptionUrl(value) {
	try {
		const url = new URL(String(value || ""));
		const hostname = url.hostname.toLowerCase();

		return (
			url.protocol === "https:" &&
			(hostname === "youtube.com" || hostname.endsWith(".youtube.com"))
		);
	} catch (_error) {
		return false;
	}
}

function createYoutubeCaptionPrefetch(options = {}) {
	const fetchImpl = options.fetch || globalThis.fetch;
	const enqueue = options.enqueue || (async () => ({ queued: 0 }));
	const onDiagnostic = options.onDiagnostic || (() => {});
	const sessions = new Map();
	const initializers = new Map();

	function getSession(context) {
		const session = sessions.get(context.tabId);

		return session &&
			(!context.sessionId || context.sessionId === session.sessionId)
			? session
			: null;
	}

	async function update(context = {}) {
		context.signal?.throwIfAborted();
		const session = getSession(context);

		if (!session) {
			return {
				available: false,
				queued: 0,
				sessionStatus: sessions.has(context.tabId) ? "stale" : "missing",
			};
		}
		if (!session.cues)
			return { available: false, queued: 0, sessionStatus: "active" };

		const playbackRate = TimedCaptions.normalizePlaybackRate(
			context.playbackRate,
		);
		const windowMs = TimedCaptions.getCaptionWindowMs(playbackRate);
		const windowCues = TimedCaptions.selectCaptionWindow(session.cues, {
			currentTimeMs: context.currentTimeMs,
			windowMs,
		});
		const items = TimedCaptions.buildTimedCaptionItems(windowCues);

		if (items.length === 0) {
			return { available: true, queued: 0, sessionStatus: "active" };
		}

		const placement =
			context.reason === "startup" || context.reason === "seek"
				? "front"
				: "back";
		const result = await enqueue({
			frameId: session.frameId,
			items,
			placement,
			playbackRate,
			sessionId: session.sessionId,
			tabId: session.tabId,
			windowMs,
		});
		const queued = Math.max(0, Number(result?.queued) || 0);

		if (getSession(context) !== session || context.signal?.aborted)
			return { available: false, queued: 0, sessionStatus: "stale" };
		onDiagnostic(
			"prefetch-window",
			`rate=${playbackRate}; window=${windowMs}ms; placement=${placement}; cues=${items.length}; queued=${queued}`,
			context,
		);
		return {
			available: true,
			queued,
			sessionStatus: result?.sessionStatus || "active",
		};
	}

	async function initialize(context = {}) {
		const unavailable = {
			available: false,
			cueCount: 0,
			queued: 0,
			sessionStatus: context.sessionId ? "active" : "missing",
		};
		const token = {};
		initializers.set(context.tabId, token);
		const isCurrent = () =>
			initializers.get(context.tabId) === token && !context.signal?.aborted;
		if (!isCurrent()) return unavailable;
		if (context.tabId && context.sessionId)
			sessions.set(context.tabId, {
				cues: null,
				frameId: context.frameId || 0,
				sessionId: context.sessionId,
				tabId: context.tabId,
			});

		let unavailableReason = "";

		if (!context.tabId) {
			unavailableReason = "Browser tab was unavailable";
		} else if (!context.sessionId) {
			unavailableReason = "Translation session was unavailable";
		} else if (!isTrustedYoutubeCaptionUrl(context.baseUrl)) {
			unavailableReason = "Timed caption URL was missing or untrusted";
		} else if (typeof fetchImpl !== "function") {
			unavailableReason = "Timed caption fetch was unavailable";
		}

		if (unavailableReason) {
			onDiagnostic(
				"prefetch-fallback",
				`${unavailableReason}; using visible captions`,
				context,
			);
			return unavailable;
		}

		try {
			context.signal?.throwIfAborted();
			const response = await waitForAbortable(
				fetchImpl(TimedCaptions.buildJson3TrackUrl(context.baseUrl), {
					credentials: "include",
					...(context.signal ? { signal: context.signal } : {}),
				}),
				context.signal,
			);
			if (!isCurrent()) return { ...unavailable, sessionStatus: "stale" };

			if (!response?.ok) {
				throw new Error(
					`Timed caption request failed with status ${response?.status || "unknown"}`,
				);
			}

			const body = await waitForAbortable(response.json(), context.signal);
			if (!isCurrent()) return { ...unavailable, sessionStatus: "stale" };
			const cues = TimedCaptions.parseJson3Captions(body).map(
				(cue, cueIndex) => ({ ...cue, cueIndex }),
			);

			if (cues.length === 0) {
				throw new Error("Timed caption response did not contain usable cues");
			}

			sessions.set(context.tabId, {
				cues,
				frameId: context.frameId || 0,
				sessionId: context.sessionId,
				tabId: context.tabId,
			});
			const result = await update({ ...context, reason: "startup" });
			if (!isCurrent()) return { ...unavailable, sessionStatus: "stale" };

			onDiagnostic(
				"prefetch-ready",
				`Loaded ${cues.length} timed caption cue(s); queued ${result.queued} for the initial playback window`,
				context,
			);

			return {
				available: true,
				cueCount: cues.length,
				queued: result.queued,
				sessionStatus: result.sessionStatus,
			};
		} catch (_error) {
			if (!isCurrent()) return { ...unavailable, sessionStatus: "stale" };
			onDiagnostic(
				"prefetch-fallback",
				"Timed captions unavailable; using visible captions",
				context,
			);
			return unavailable;
		}
	}

	function remove(tabId) {
		initializers.delete(tabId);
		return sessions.delete(tabId);
	}

	return { initialize, remove, update };
}

export { createYoutubeCaptionPrefetch, isTrustedYoutubeCaptionUrl };
