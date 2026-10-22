import { Theme } from "@radix-ui/themes";
import { Tabs } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";

import * as Settings from "../shared/settings.js";
import { AdvancedSection } from "./advanced-section.jsx";
import { AppearanceSection } from "./appearance-section.jsx";
import {
	applyAppearancePreset,
	buildPromptPreview,
	clearEditedFieldError,
	createOptionsDraft,
	getConnectionErrorMessage,
	getInvalidFieldIds,
	isOptionsDraftDirty,
	resetAppearanceDraft,
	updateDraftField,
} from "./model.js";
import { createOptionsApi } from "./options-api.js";
import {
	OptionsHeader,
	SaveBar,
	SettingsNavigation,
} from "./options-shell.jsx";
import { PromptsSection } from "./prompts-section.jsx";
import { AuthenticationDialog, SetupSection } from "./setup-section.jsx";
import { useSystemTheme } from "./use-system-theme.js";

const optionsApi = createOptionsApi();
const INITIAL_PERMISSION = Object.freeze({
	granted: false,
	message: "Checking permission…",
	origins: [],
	status: "checking",
});
const INITIAL_TEST_STATE = Object.freeze({
	details: "Sends one sample translation through the selected pi-ai model.",
	status: "Ready to test your connection.",
});
const INITIAL_AUTH_FLOW = Object.freeze({
	event: null,
	open: false,
	prompt: null,
	providerId: "",
	providerName: "provider",
	selectingMethod: false,
	value: "",
});

function formatAuthStatus(status, providerId, providers) {
	const provider = providers.find((item) => item.id === providerId);
	const providerName = provider?.name || providerId || "Provider";
	return {
		...status,
		message: status?.loggedIn
			? `${providerName} configured with ${status.type === "oauth" ? "an account" : "an API key"}.`
			: `${providerName} is not configured.`,
	};
}

function OptionsApp() {
	const theme = useSystemTheme();
	const [draft, setDraft] = useState(() =>
		createOptionsDraft(Settings.DEFAULT_SETTINGS),
	);
	const [savedSettings, setSavedSettings] = useState(() =>
		createOptionsDraft(Settings.DEFAULT_SETTINGS),
	);
	const [activeTab, setActiveTab] = useState("setup");
	const [catalog, setCatalog] = useState([]);
	const [authStatus, setAuthStatus] = useState({
		loggedIn: false,
		message: "Checking authentication…",
	});
	const [authBusy, setAuthBusy] = useState(false);
	const [authFlow, setAuthFlow] = useState(INITIAL_AUTH_FLOW);
	const [focusTarget, setFocusTarget] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [loadError, setLoadError] = useState("");
	const [invalidFields, setInvalidFields] = useState(() => new Set());
	const [permission, setPermission] = useState(INITIAL_PERMISSION);
	const [testState, setTestState] = useState(INITIAL_TEST_STATE);
	const [banner, setBanner] = useState(null);
	const [previewTheme, setPreviewTheme] = useState("light");
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const draftRef = useRef(draft);
	const operations = useRef({ save: false, test: false });
	const permissionRequest = useRef(0);
	const promptResolution = useRef(null);

	draftRef.current = draft;

	useEffect(() => {
		let active = true;

		async function load() {
			setLoaded(false);
			setLoadError("");
			setInvalidFields(new Set());
			setBanner(null);

			try {
				const settings = await Settings.getSettings();
				const nextDraft = createOptionsDraft(settings);
				const [providers, providerStatus, permissionStatus] = await Promise.all(
					[
						optionsApi.getCatalog(nextDraft),
						optionsApi.getAuthStatus(nextDraft.provider),
						optionsApi.getPermissionStatus(nextDraft),
					],
				);

				if (!active) {
					return;
				}

				setCatalog(providers);
				setDraft(nextDraft);
				setSavedSettings(nextDraft);
				setAuthStatus(
					formatAuthStatus(providerStatus, nextDraft.provider, providers),
				);
				setPermission(permissionStatus);
				setLoaded(true);
			} catch (_error) {
				if (!active) {
					return;
				}

				setLoadError("Settings could not be loaded.");
				setBanner({
					message: "Settings could not be loaded. Retry before editing.",
					tone: "red",
				});
			}
		}

		load();
		return () => {
			active = false;
		};
	}, []);

	useEffect(() => {
		if (focusTarget) {
			document.getElementById(focusTarget)?.focus();
			setFocusTarget("");
		}
	}, [focusTarget]);

	function revealInvalidField(id) {
		const field = document.getElementById(id);
		const panel = field?.closest("[data-panel]");
		if (panel) {
			field
				.closest(".appearance-disclosure")
				?.querySelector('.appearance-disclosure-trigger[data-state="closed"]')
				?.click();
			setActiveTab(panel.dataset.panel);
			setFocusTarget(id);
		}
	}

	function showValidationErrors(validation) {
		const ids = getInvalidFieldIds(validation.invalidFields);
		setInvalidFields(new Set(ids));
		setBanner({ message: validation.errors.join(" "), tone: "red" });
		revealInvalidField(ids[0]);
	}

	function handleInvalid(event) {
		event.preventDefault();
		const fields = [
			...event.currentTarget.querySelectorAll(
				"input:invalid, select:invalid, textarea:invalid",
			),
		];
		if (event.target !== fields[0]) {
			return;
		}
		setInvalidFields(new Set(fields.map((field) => field.id)));
		setBanner({
			message: `${event.target.labels?.[0]?.textContent || "Invalid value"}: ${event.target.validationMessage}`,
			tone: "red",
		});
		revealInvalidField(event.target.id);
	}

	const dirty = useMemo(
		() => loaded && isOptionsDraftDirty(draft, savedSettings),
		[draft, loaded, savedSettings],
	);
	const promptPreview = useMemo(() => buildPromptPreview(draft), [draft]);

	async function refreshPermission(settings) {
		const requestId = permissionRequest.current + 1;
		permissionRequest.current = requestId;
		setPermission(INITIAL_PERMISSION);
		const next = await optionsApi.getPermissionStatus(settings);

		if (permissionRequest.current === requestId) {
			setPermission(next);
		}

		return next;
	}

	function onField(path, value) {
		setInvalidFields((current) => clearEditedFieldError(current, path));
		setDraft((current) => updateDraftField(current, path, value));
	}

	async function refreshAuthStatus(providerId, providers = catalog) {
		const status = await optionsApi.getAuthStatus(providerId);
		setAuthStatus(formatAuthStatus(status, providerId, providers));
		return status;
	}

	function onProvider(providerId) {
		const provider = catalog.find((item) => item.id === providerId);
		setInvalidFields((current) => clearEditedFieldError(current, "provider"));
		setDraft((current) => {
			const next = updateDraftField(current, "provider", providerId);
			if (providerId !== Settings.CUSTOM_PROVIDER) {
				next.model = provider?.models[0]?.id || "";
			}
			draftRef.current = next;
			return next;
		});
		setAuthStatus({
			loggedIn: false,
			message: `Checking ${provider?.name || providerId} authentication…`,
		});
		void refreshAuthStatus(providerId).catch(() => {
			setAuthStatus({
				loggedIn: false,
				message: "Authentication status is unavailable.",
			});
		});
		queueMicrotask(() => void refreshPermission(draftRef.current));
	}

	function promptForCredential(prompt) {
		return new Promise((resolve, reject) => {
			promptResolution.current = { reject, resolve };
			setAuthFlow((current) => ({
				...current,
				event: current.event?.type === "auth_url" ? current.event : null,
				open: true,
				prompt,
				selectingMethod: false,
				value: prompt.type === "select" ? prompt.options[0]?.id || "" : "",
			}));
		});
	}

	function handleAuthEvent(event) {
		setAuthFlow((current) => ({
			...current,
			event,
			open: true,
			prompt: null,
			value: "",
		}));
	}

	function submitAuthPrompt(event) {
		event.preventDefault();
		if (authFlow.selectingMethod) {
			const authType = authFlow.value;
			setAuthFlow((current) => ({
				...current,
				event: { type: "progress", message: "Starting authentication…" },
				prompt: null,
				selectingMethod: false,
				value: "",
			}));
			void runAuthentication(authFlow.providerId, authType);
			return;
		}

		const pending = promptResolution.current;
		if (!pending) {
			return;
		}
		promptResolution.current = null;
		pending.resolve(authFlow.value);
		setAuthFlow((current) => ({
			...current,
			event: { type: "progress", message: "Continuing authentication…" },
			prompt: null,
			value: "",
		}));
	}

	function cancelAuthentication() {
		promptResolution.current?.reject(
			new DOMException("Authentication cancelled.", "AbortError"),
		);
		promptResolution.current = null;
		optionsApi.auth.cancel();
		setAuthFlow(INITIAL_AUTH_FLOW);
		if (authFlow.selectingMethod) {
			setAuthBusy(false);
		}
	}

	function handleAuthenticate() {
		if (authBusy) {
			return;
		}
		const provider = catalog.find((item) => item.id === draft.provider);
		const methods = provider?.authMethods || [];
		if (methods.length === 0) {
			setBanner({
				message: "This provider has no interactive authentication method.",
				tone: "red",
			});
			return;
		}

		setAuthBusy(true);
		setBanner(null);
		if (methods.length === 1) {
			setAuthFlow({
				...INITIAL_AUTH_FLOW,
				event: { type: "progress", message: "Starting authentication…" },
				open: true,
				providerId: provider.id,
				providerName: provider.name,
			});
			void runAuthentication(provider.id, methods[0].type);
			return;
		}

		const methodOptions = [
			methods.some((method) => method.type === "oauth")
				? { id: "oauth", label: "Sign in with an account" }
				: null,
			methods.some((method) => method.type === "api_key")
				? { id: "api_key", label: "Sign in with an API key" }
				: null,
		].filter(Boolean);
		setAuthFlow({
			...INITIAL_AUTH_FLOW,
			open: true,
			prompt: {
				message: "Select authentication method:",
				options: methodOptions,
				type: "select",
			},
			providerId: provider.id,
			providerName: provider.name,
			selectingMethod: true,
			value: methodOptions[0].id,
		});
	}

	async function runAuthentication(providerId, authType) {
		const provider = catalog.find((item) => item.id === providerId);
		const method = provider?.authMethods.find((item) => item.type === authType);
		try {
			if (!method) {
				throw new Error("The selected authentication method is unavailable.");
			}
			const granted = await optionsApi.requestOrigins(
				method.setupOrigins || [],
			);
			if (!granted) {
				throw new Error("Provider authentication permission was denied.");
			}
			await optionsApi.auth.login(providerId, authType, {
				onEvent: handleAuthEvent,
				onPrompt: promptForCredential,
			});
			const providers = await optionsApi.getCatalog(draftRef.current);
			const refreshedProvider = providers.find(
				(item) => item.id === providerId,
			);
			setCatalog(providers);
			setDraft((current) => {
				if (
					current.provider !== providerId ||
					refreshedProvider?.models.some((model) => model.id === current.model)
				) {
					return current;
				}
				const next = {
					...current,
					model: refreshedProvider?.models[0]?.id || "",
				};
				draftRef.current = next;
				return next;
			});
			await refreshAuthStatus(providerId, providers);
			await refreshPermission(draftRef.current);
			setBanner({
				message: `${provider?.name || "Provider"} authentication saved.`,
				tone: "green",
			});
		} catch (error) {
			setBanner({
				message: error.message || "Authentication failed.",
				tone: "red",
			});
		} finally {
			promptResolution.current = null;
			setAuthFlow(INITIAL_AUTH_FLOW);
			setAuthBusy(false);
		}
	}

	async function handleRefreshCredential() {
		setAuthBusy(true);
		setBanner(null);
		try {
			await optionsApi.auth.refresh(draft.provider);
			await refreshAuthStatus(draft.provider);
			setBanner({ message: "Credential refreshed.", tone: "green" });
		} catch (error) {
			setBanner({ message: error.message, tone: "red" });
		} finally {
			setAuthBusy(false);
		}
	}

	async function handleLogout() {
		setAuthBusy(true);
		setBanner(null);
		try {
			await optionsApi.auth.logout(draft.provider);
			await refreshAuthStatus(draft.provider);
			setBanner({ message: "Credential removed.", tone: "green" });
		} catch (error) {
			setBanner({ message: error.message, tone: "red" });
		} finally {
			setAuthBusy(false);
		}
	}

	function onAppearanceField(path, value) {
		onField(["translationAppearance", ...path], value);
	}

	function resetPrompt(kind) {
		const system = kind === "system";
		onField(
			system ? "systemPromptTemplate" : "userPromptTemplate",
			system
				? Settings.DEFAULT_SETTINGS.systemPromptTemplate
				: Settings.DEFAULT_SETTINGS.userPromptTemplate,
		);
		setBanner({
			message: `${system ? "System" : "User"} prompt template reset to the default value.`,
			tone: "green",
		});
	}

	function resetAppearance() {
		setDraft((current) => resetAppearanceDraft(current));
		setBanner({
			message: "Appearance reset to Calm Reading. Save settings to apply it.",
			tone: "green",
		});
	}

	async function handleSave(event) {
		event.preventDefault();
		if (operations.current.save || !loaded) {
			return;
		}

		operations.current.save = true;
		setSaving(true);
		setBanner(null);

		try {
			const validation = Settings.validateSettings(draft);

			if (!validation.isValid) {
				showValidationErrors(validation);
				await refreshPermission(draft);
				return;
			}

			const saved = await Settings.saveSettings(validation.settings);

			setInvalidFields(new Set());
			setSavedSettings(createOptionsDraft(saved));
			await refreshPermission(draftRef.current);
			setBanner({
				message:
					"Settings saved. Provider access will be requested when needed.",
				tone: "green",
			});
		} catch (error) {
			setBanner({
				message: `Settings could not be saved. ${error.message || "Try again."}`,
				tone: "red",
			});
		} finally {
			operations.current.save = false;
			setSaving(false);
		}
	}

	async function handleTestConnection() {
		if (operations.current.test || !loaded) {
			return;
		}

		operations.current.test = true;
		setTesting(true);
		setBanner(null);
		setTestState({
			details: "Sending a sample translation through pi-ai…",
			status: "Testing connection…",
		});

		try {
			const validation = Settings.validateSettings(draft);

			if (!validation.isValid) {
				showValidationErrors(validation);
				setTestState({
					details: "Fix the settings errors and try again.",
					status: "Validation failed.",
				});
				return;
			}

			setInvalidFields(new Set());
			const permissionGranted = await optionsApi.requestPermission(
				validation.settings,
			);
			await refreshPermission(validation.settings);

			if (!permissionGranted) {
				setTestState({
					details: "Grant the API origin permission to continue.",
					status: "Permission denied.",
				});
				setBanner({
					message: "API origin permission is required to test the connection.",
					tone: "red",
				});
				return;
			}

			const response = await optionsApi.testConnection(validation.settings);

			if (!response?.ok) {
				setTestState({
					details: "The extension could not complete the test request.",
					status: "Connection test failed.",
				});
				setBanner({
					message: getConnectionErrorMessage(response?.error),
					tone: "red",
				});
				return;
			}

			const draftChanged = isOptionsDraftDirty(
				draftRef.current,
				validation.settings,
			);
			const resultDetails = `Translation latency: ${response.latencyMs || 0} ms · ${response.provider || validation.settings.provider}/${response.model || validation.settings.model}.`;

			setTestState({
				details: draftChanged
					? `Settings changed during the test; these results cover earlier values. ${resultDetails}`
					: resultDetails,
				status: `Sample translation: ${response.translation || "(empty)"}`,
			});
			setBanner(
				draftChanged
					? {
							message:
								"Connection test succeeded for earlier values. Run it again to verify the current draft.",
							tone: "amber",
						}
					: { message: "Connection test succeeded.", tone: "green" },
			);
		} catch (_error) {
			setTestState({
				details: "The extension could not complete the test request.",
				status: "Connection test failed.",
			});
			setBanner({
				message: "Connection test failed. Check the endpoint and try again.",
				tone: "red",
			});
		} finally {
			operations.current.test = false;
			setTesting(false);
		}
	}

	return (
		<Theme
			accentColor="teal"
			appearance={theme}
			grayColor="sage"
			hasBackground={false}
			radius="large"
			scaling="100%"
		>
			<main className="options-layout">
				<OptionsHeader />

				<form
					aria-busy={!loaded}
					className="options-form"
					data-validation-attempted={invalidFields.size > 0}
					id="settings-form"
					onInvalid={handleInvalid}
					onSubmit={handleSave}
				>
					<fieldset className="options-fieldset" disabled={!loaded}>
						<Tabs.Root value={activeTab} onValueChange={setActiveTab}>
							<SettingsNavigation />

							<Tabs.Content
								className="tab-content"
								data-panel="setup"
								forceMount
								value="setup"
							>
								<SetupSection
									auth={{ busy: authBusy, status: authStatus }}
									catalog={catalog}
									draft={draft}
									invalidFields={invalidFields}
									onAuthenticate={handleAuthenticate}
									onBlurProvider={() => refreshPermission(draftRef.current)}
									onField={onField}
									onLogout={handleLogout}
									onProvider={onProvider}
									onRefreshCredential={handleRefreshCredential}
									permission={permission}
									testState={testState}
								/>
							</Tabs.Content>
							<Tabs.Content
								className="tab-content"
								data-panel="appearance"
								forceMount
								value="appearance"
							>
								<AppearanceSection
									dirty={dirty}
									draft={draft}
									onAppearanceField={onAppearanceField}
									onApplyPreset={(presetId) =>
										setDraft((current) =>
											applyAppearancePreset(current, presetId),
										)
									}
									onField={onField}
									onResetAppearance={resetAppearance}
									previewTheme={previewTheme}
									setPreviewTheme={setPreviewTheme}
								/>
							</Tabs.Content>
							<Tabs.Content
								className="tab-content"
								data-panel="prompts"
								forceMount
								value="prompts"
							>
								<PromptsSection
									draft={draft}
									invalidFields={invalidFields}
									onField={onField}
									onReset={resetPrompt}
									preview={promptPreview}
								/>
							</Tabs.Content>
							<Tabs.Content
								className="tab-content"
								data-panel="advanced"
								forceMount
								value="advanced"
							>
								<AdvancedSection draft={draft} onField={onField} />
							</Tabs.Content>
						</Tabs.Root>
					</fieldset>

					<SaveBar
						banner={banner}
						dirty={dirty}
						loaded={loaded}
						loadError={loadError}
						onTest={handleTestConnection}
						saving={saving}
						testing={testing}
					/>
				</form>
				<AuthenticationDialog
					flow={{
						...authFlow,
						setValue: (value) =>
							setAuthFlow((current) => ({ ...current, value })),
					}}
					onCancel={cancelAuthentication}
					onOpenUrl={(url) => optionsApi.openUrl(url)}
					onSubmit={submitAuthPrompt}
				/>
			</main>
		</Theme>
	);
}

export { OptionsApp };
export default OptionsApp;
