function waitForAbortable(operation, signal) {
	const pending = Promise.resolve(operation);
	if (!signal) {
		return pending;
	}

	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(
				signal.reason ??
					new DOMException("The operation was aborted.", "AbortError"),
			);
		};
		pending.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				if (signal.aborted) {
					onAbort();
				} else {
					resolve(value);
				}
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				if (signal.aborted) {
					onAbort();
				} else {
					reject(error);
				}
			},
		);
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

export { waitForAbortable };
