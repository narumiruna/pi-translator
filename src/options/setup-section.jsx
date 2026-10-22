import {
	GlobeIcon,
	LightningBoltIcon,
	LockClosedIcon,
	VideoIcon,
} from "@radix-ui/react-icons";
import { Text } from "@radix-ui/themes";
import { Dialog } from "radix-ui";
import { useEffect, useRef } from "react";

import { BASIC_THINKING_LEVELS } from "../shared/settings.js";
import {
	Button,
	FormSection,
	NativeSelect,
	SearchableSelect,
	StatusCard,
	TextInput,
} from "./components.jsx";

function AuthenticationDialog({ flow, onCancel, onOpenUrl, onSubmit }) {
	const promptRef = useRef(null);
	const prompt = flow.prompt;

	useEffect(() => {
		if (flow.open && prompt) {
			promptRef.current?.focus();
		}
	}, [flow.open, prompt]);
	const authUrl = flow.event?.type === "auth_url" ? flow.event : null;
	const deviceCode = flow.event?.type === "device_code" ? flow.event : null;
	const info = ["info", "progress"].includes(flow.event?.type)
		? flow.event
		: null;

	return (
		<Dialog.Root
			open={flow.open}
			onOpenChange={(open) => {
				if (!open) onCancel();
			}}
		>
			<Dialog.Portal container={document.querySelector(".radix-themes")}>
				<Dialog.Overlay className="auth-dialog-backdrop" />
				<Dialog.Content
					className="auth-dialog"
					aria-describedby={undefined}
					onCloseAutoFocus={(event) => event.preventDefault()}
					onInteractOutside={(event) => event.preventDefault()}
				>
					<Dialog.Title asChild>
						<h2>Configure {flow.providerName}</h2>
					</Dialog.Title>
					{authUrl ? (
						<div className="auth-url-flow">
							<Text as="p" size="2">
								{authUrl.instructions ||
									"Continue authentication in your browser."}
							</Text>
							<Button
								highContrast
								onClick={() => onOpenUrl(authUrl.url)}
								type="button"
							>
								Open sign-in page
							</Button>
							{!prompt ? (
								<Button
									color="gray"
									onClick={onCancel}
									type="button"
									variant="soft"
								>
									Cancel
								</Button>
							) : null}
						</div>
					) : null}
					{prompt ? (
						<form onSubmit={onSubmit}>
							<label className="field" htmlFor="auth-prompt-value">
								<span className="field-label">{prompt.message}</span>
								{prompt.type === "select" ? (
									<select
										className="native-select"
										ref={promptRef}
										id="auth-prompt-value"
										onChange={(event) => flow.setValue(event.target.value)}
										value={flow.value}
									>
										{prompt.options.map((option) => (
											<option key={option.id} value={option.id}>
												{option.label}
												{option.description ? ` — ${option.description}` : ""}
											</option>
										))}
									</select>
								) : (
									<input
										autoComplete="off"
										className="auth-prompt-input"
										ref={promptRef}
										key={prompt.type}
										id="auth-prompt-value"
										onChange={(event) => flow.setValue(event.target.value)}
										placeholder={prompt.placeholder || ""}
										type={prompt.type === "secret" ? "password" : "text"}
										value={flow.value}
									/>
								)}
							</label>
							<div className="auth-dialog-actions">
								<Button
									color="gray"
									onClick={onCancel}
									type="button"
									variant="soft"
								>
									Cancel
								</Button>
								<Button highContrast type="submit">
									Continue
								</Button>
							</div>
						</form>
					) : null}
					{deviceCode ? (
						<div className="device-code-flow">
							<Text as="p" size="2">
								Open the sign-in page and enter this one-time code:
							</Text>
							<output className="device-code">{deviceCode.userCode}</output>
							<div className="auth-dialog-actions">
								<Button
									color="gray"
									onClick={onCancel}
									type="button"
									variant="soft"
								>
									Cancel
								</Button>
								<Button
									highContrast
									onClick={() => onOpenUrl(deviceCode.verificationUri)}
									type="button"
								>
									Open sign-in page
								</Button>
							</div>
						</div>
					) : null}
					{!prompt && !deviceCode && !authUrl ? (
						<div>
							<Text as="p" aria-live="polite" size="2">
								{info?.message || "Starting authentication…"}
							</Text>
							{info?.links?.map((link) => (
								<Button
									key={link.url}
									onClick={() => onOpenUrl(link.url)}
									type="button"
									variant="soft"
								>
									{link.label || "Open documentation"}
								</Button>
							))}
							<div className="auth-dialog-actions">
								<Button
									color="gray"
									onClick={onCancel}
									type="button"
									variant="soft"
								>
									Cancel
								</Button>
							</div>
						</div>
					) : null}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function SetupSection({
	auth,
	catalog,
	draft,
	invalidFields,
	onAuthenticate,
	onBlurProvider,
	onField,
	onLogout,
	onProvider,
	onRefreshCredential,
	permission,
	testState,
}) {
	const provider = catalog.find((item) => item.id === draft.provider);
	const models = provider?.models || [];
	const selectedModel = models.find((item) => item.id === draft.model);
	const customProvider = draft.provider === "openai-compatible";
	const thinkingLevels = customProvider
		? BASIC_THINKING_LEVELS
		: selectedModel?.thinkingLevels || [];
	const unsupportedThinkingLevel =
		draft.thinkingLevel !== "default" &&
		!thinkingLevels.includes(draft.thinkingLevel);
	const thinkingNote = unsupportedThinkingLevel
		? "The saved level is unavailable for this model. Model defaults will be used until you choose a supported level."
		: customProvider
			? "The endpoint must support the selected reasoning effort. Default keeps existing behavior; higher levels may increase latency and cost."
			: !selectedModel?.reasoning
				? "This model does not support thinking. The setting is ignored."
				: "Default keeps existing model behavior. Higher levels may increase latency and cost.";

	return (
		<div className="setup-grid">
			<FormSection
				id="api-section-title"
				icon={LightningBoltIcon}
				title="Model Provider"
				description="Choose any browser-compatible provider and model from pi-ai."
			>
				<div className="field-stack">
					<SearchableSelect
						id="provider"
						invalid={invalidFields.has("provider")}
						label="Provider"
						name="provider"
						note={`${catalog.length} providers are available in this browser build. Type to search by provider name or ID.`}
						onValueChange={onProvider}
						options={catalog.map((item) => ({
							keywords: [item.id],
							label: `${item.name} (${item.models.length})`,
							value: item.id,
						}))}
						placeholder="Search providers"
						required
						value={draft.provider}
					/>
					{customProvider ? (
						<>
							<TextInput
								autoCapitalize="none"
								id="custom-base-url"
								inputMode="url"
								invalid={invalidFields.has("custom-base-url")}
								label="Base URL"
								name="customBaseUrl"
								note={
									<>
										Your OpenAI-compatible Responses endpoint, including{" "}
										<code>/v1</code>.
									</>
								}
								onBlur={onBlurProvider}
								onChange={(event) =>
									onField("customBaseUrl", event.target.value)
								}
								placeholder="https://api.example.com/v1"
								required
								spellCheck={false}
								type="url"
								value={draft.customBaseUrl}
							/>
							<TextInput
								autoCapitalize="none"
								id="model"
								invalid={invalidFields.has("model")}
								label="Model"
								name="model"
								note="Use the exact model name exposed by the endpoint."
								onChange={(event) => onField("model", event.target.value)}
								placeholder="model-name"
								required
								spellCheck={false}
								value={draft.model}
							/>
						</>
					) : (
						<SearchableSelect
							id="model"
							invalid={invalidFields.has("model")}
							label="Model"
							name="model"
							note={
								selectedModel
									? `${selectedModel.api} · ${selectedModel.contextWindow.toLocaleString()} token context${selectedModel.reasoning ? " · reasoning" : ""} · Type to search by model name or ID.`
									: "Select a model from this provider."
							}
							onBlur={onBlurProvider}
							onValueChange={(value) => onField("model", value)}
							options={models.map((item) => ({
								keywords: [item.id, item.name, item.api],
								label:
									item.name === item.id ? item.id : `${item.name} — ${item.id}`,
								value: item.id,
							}))}
							placeholder="Search models"
							required
							value={draft.model}
						/>
					)}
					<NativeSelect
						disabled={!customProvider && !selectedModel}
						id="thinking-level"
						label="Thinking Level"
						name="thinkingLevel"
						note={thinkingNote}
						onChange={(event) => onField("thinkingLevel", event.target.value)}
						value={draft.thinkingLevel}
					>
						<option value="default">Default</option>
						{thinkingLevels.map((level) => (
							<option key={level} value={level}>
								{level === "xhigh"
									? "Extra High"
									: level[0].toUpperCase() + level.slice(1)}
							</option>
						))}
						{unsupportedThinkingLevel ? (
							<option disabled value={draft.thinkingLevel}>
								{draft.thinkingLevel} (unavailable)
							</option>
						) : null}
					</NativeSelect>
				</div>

				<div className="credential-panel">
					<div>
						<Text as="p" size="2" weight="medium">
							Authentication
						</Text>
						<Text as="p" className="field-note" id="auth-status" size="1">
							{auth.status.message}
						</Text>
					</div>
					<div className="credential-actions">
						{provider?.authMethods.length > 0 ? (
							<Button
								disabled={auth.busy}
								highContrast
								onClick={onAuthenticate}
								type="button"
								variant="soft"
							>
								{auth.status.loggedIn
									? "Change authentication"
									: "Configure authentication"}
							</Button>
						) : null}
						{auth.status.loggedIn && auth.status.type === "oauth" ? (
							<Button
								disabled={auth.busy}
								highContrast
								onClick={onRefreshCredential}
								type="button"
								variant="soft"
							>
								Refresh credential
							</Button>
						) : null}
						{auth.status.loggedIn ? (
							<Button
								color="red"
								disabled={auth.busy}
								highContrast
								onClick={onLogout}
								type="button"
								variant="soft"
							>
								Remove credential
							</Button>
						) : null}
					</div>
				</div>

				<div className="privacy-note">
					<LockClosedIcon aria-hidden="true" />
					<Text as="p" size="1">
						Credentials stay in local trusted extension storage. Provider access
						is limited to the selected model endpoint.
					</Text>
				</div>
			</FormSection>

			<div className="setup-preferences">
				<FormSection
					id="language-section-title"
					icon={GlobeIcon}
					title="Language"
				>
					<TextInput
						id="target-language"
						invalid={invalidFields.has("target-language")}
						label="Target Language"
						name="targetLanguage"
						note="Translate pages and selected text into this language."
						onChange={(event) => onField("targetLanguage", event.target.value)}
						placeholder="Traditional Chinese (Taiwan)"
						required
						value={draft.targetLanguage}
					/>
				</FormSection>

				<FormSection
					id="youtube-subtitles-section-title"
					icon={VideoIcon}
					title="YouTube Subtitles"
				>
					<fieldset
						className="choice-group"
						aria-describedby="youtube-subtitle-display-note"
					>
						<legend>Display Mode</legend>
						<Text
							as="p"
							className="field-note"
							id="youtube-subtitle-display-note"
							size="1"
						>
							Choose how translated captions appear in the player.
						</Text>
						<label className="choice-option">
							<input
								checked={draft.youtubeSubtitleDisplayMode === "bilingual"}
								name="youtubeSubtitleDisplayMode"
								onChange={(event) =>
									onField("youtubeSubtitleDisplayMode", event.target.value)
								}
								type="radio"
								value="bilingual"
							/>
							<span>
								<strong>Original and translation</strong>
								<small>Keep the original above its translation.</small>
							</span>
						</label>
						<label className="choice-option">
							<input
								checked={
									draft.youtubeSubtitleDisplayMode === "translation-only"
								}
								name="youtubeSubtitleDisplayMode"
								onChange={(event) =>
									onField("youtubeSubtitleDisplayMode", event.target.value)
								}
								type="radio"
								value="translation-only"
							/>
							<span>
								<strong>Translation only</strong>
								<small>Hide the original when its translation is ready.</small>
							</span>
						</label>
					</fieldset>
				</FormSection>
			</div>

			<section className="status-grid" aria-label="Connection status">
				<StatusCard title="Provider Origin Permission">
					<Text
						as="p"
						aria-live="polite"
						className="status-text"
						data-status={permission.status}
						id="permission-status"
						size="2"
					>
						{permission.message}
					</Text>
				</StatusCard>
				<StatusCard title="Connection Test">
					<Text
						as="p"
						aria-live="polite"
						className="status-text"
						id="test-status"
						size="2"
					>
						{testState.status}
					</Text>
					<Text
						as="p"
						className="field-note status-detail"
						id="test-details"
						size="1"
					>
						{testState.details}
					</Text>
				</StatusCard>
			</section>
		</div>
	);
}

export { AuthenticationDialog, SetupSection };
export default SetupSection;
