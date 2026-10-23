import {
	CheckIcon,
	CodeIcon,
	DotFilledIcon,
	GlobeIcon,
	LightningBoltIcon,
	MixerHorizontalIcon,
	ReloadIcon,
	RocketIcon,
	TokensIcon,
} from "@radix-ui/react-icons";
import { Heading, Spinner, Text } from "@radix-ui/themes";
import { Tabs } from "radix-ui";

import { Button, StatusBanner } from "./components.jsx";

const SECTIONS = [
	{ value: "setup", label: "Setup", icon: RocketIcon },
	{ value: "appearance", label: "Appearance", icon: TokensIcon },
	{ value: "prompts", label: "Prompts", icon: CodeIcon },
	{ value: "advanced", label: "Advanced", icon: MixerHorizontalIcon },
];

function OptionsHeader() {
	return (
		<>
			<div className="brand-bar">
				<div className="brand">
					<span className="brand-mark">
						<GlobeIcon aria-hidden="true" />
					</span>
					<div>
						<Text as="p" size="3" weight="bold">
							Pi Translator
						</Text>
						<Text as="p" color="gray" size="1">
							Read beyond language.
						</Text>
					</div>
				</div>
				<Text as="span" className="compatibility-badge" size="1">
					<LightningBoltIcon aria-hidden="true" /> OpenAI-compatible
				</Text>
			</div>
			<header className="hero">
				<Text as="p" className="eyebrow" size="1" weight="bold">
					Make it yours
				</Text>
				<Heading as="h1" size="8">
					Settings
				</Heading>
				<Text as="p" className="subtitle" color="gray" size="3">
					Connect your model. Shape your reading experience.
				</Text>
			</header>
		</>
	);
}

function SettingsNavigation() {
	return (
		<Tabs.List aria-label="Settings sections" className="tab-list">
			{SECTIONS.map(({ value, label, icon: Icon }) => (
				<Tabs.Trigger
					className="tab-trigger"
					data-tab={value}
					key={value}
					value={value}
				>
					<Icon aria-hidden="true" />
					{label}
				</Tabs.Trigger>
			))}
		</Tabs.List>
	);
}

function SaveBar({
	banner,
	dirty,
	loaded,
	loadError,
	onTest,
	saving,
	testing,
}) {
	return (
		<div className="save-bar" data-dirty={dirty}>
			<div className="save-bar-main">
				<div className="save-summary">
					<Text
						as="span"
						aria-live="polite"
						className="save-state"
						color={dirty ? "amber" : "gray"}
						id="save-state"
						size="2"
						weight="medium"
					>
						{!loaded ? (
							loadError ? (
								<>
									<ReloadIcon aria-hidden="true" /> Settings unavailable
								</>
							) : (
								<>
									<Spinner size="1" /> Loading settings…
								</>
							)
						) : dirty ? (
							<>
								<DotFilledIcon aria-hidden="true" /> Unsaved changes
							</>
						) : (
							<>
								<CheckIcon aria-hidden="true" /> No unsaved changes.
							</>
						)}
					</Text>
					{loaded ? (
						<Text as="p" className="save-hint" color="gray" size="1">
							{dirty ? "Save to apply your changes." : "Ready when you are."}
						</Text>
					) : null}
				</div>
				<div className="save-bar-actions">
					<Button
						disabled={!loaded || saving || testing}
						highContrast
						id="test-button"
						onClick={onTest}
						size="3"
						type="button"
						variant="surface"
					>
						{testing ? (
							<Spinner size="1" />
						) : (
							<LightningBoltIcon aria-hidden="true" />
						)}
						{testing ? "Testing…" : "Test Connection"}
					</Button>
					<Button
						disabled={!loaded || saving || testing}
						highContrast
						id="save-button"
						size="3"
						type="submit"
					>
						{saving ? <Spinner size="1" /> : <CheckIcon aria-hidden="true" />}
						{saving ? "Saving…" : "Save Settings"}
					</Button>
					{loadError ? (
						<Button
							onClick={() => globalThis.location.reload()}
							type="button"
							variant="soft"
						>
							<ReloadIcon aria-hidden="true" /> Retry loading
						</Button>
					) : null}
				</div>
			</div>
			<StatusBanner banner={banner} />
		</div>
	);
}

export { OptionsHeader, SaveBar, SettingsNavigation };
