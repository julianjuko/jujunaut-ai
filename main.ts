import {
	App,
	Editor,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";

interface JujunautAiSettings {
	frequencyPenalty: number;
	maxTokens: number;
	openAiApiKey: string;
	presencePenalty: number;
	temperature: number;
	topP: number;
}

const DEFAULT_SETTINGS: JujunautAiSettings = {
	frequencyPenalty: 0,
	maxTokens: 4096,
	openAiApiKey: "",
	presencePenalty: 0,
	temperature: 0.5,
	topP: 0.95,
};

export default class JujunautAiPlugin extends Plugin {
	settings: JujunautAiSettings;
	private streamReader: ReadableStreamDefaultReader | null = null;
	private isStreaming = false;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "generate-text-from-openai",
			name: "Generate Text from OpenAI",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.generateText(editor, view);
			},
		});

		this.addCommand({
			id: "stop-text-streaming",
			name: "Stop Text Streaming",
			callback: () => {
				this.stopStreaming();
			},
		});

		const ribbonIconEl = this.addRibbonIcon(
			"star",
			"Jujunaut AI",
			async (evt: MouseEvent) => {
				const activeView =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView) {
					this.generateText(activeView.editor, activeView);
				} else {
					new Notice("Open a markdown note to use Jujunaut AI.");
				}
			}
		);
		ribbonIconEl.addClass("jujunaut-ai-ribbon-class");

		this.addSettingTab(new OpenAiSettingTab(this.app, this));
	}

	onunload() {}

	async generateText(editor: Editor, view: MarkdownView) {
		const text = view.data;
		if (text.trim().length === 0) {
			new Notice("The note is empty. Please add some content.");
			return;
		}
		if (this.isStreaming) {
			new Notice(
				"Streaming is already in progress. Please stop it first."
			);
			return;
		}
		await this.streamOpenAI(text, editor);
	}

	async streamOpenAI(prompt: string, editor: Editor): Promise<void> {
		const apiKey = this.settings.openAiApiKey;

		const response = await fetch(
			"https://api.openai.com/v1/chat/completions",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					frequency_penalty: this.settings.frequencyPenalty,
					max_tokens: this.settings.maxTokens,
					model: "gpt-4-turbo",
					messages: [
						{
							role: "user",
							content: prompt,
						},
					],
					presence_penalty: this.settings.presencePenalty,
					stream: true,
					temperature: this.settings.temperature,
					top_p: this.settings.topP,
				}),
			}
		);

		if (!response.body) {
			new Notice("Failed to receive streamable response.");
			return;
		}

		this.streamReader = response.body.getReader();
		this.isStreaming = true;
		let buffer = "";

		try {
			while (this.isStreaming) {
				const { done, value } = await this.streamReader.read();
				if (done) {
					break;
				}

				let chunk = new TextDecoder().decode(value);
				chunk = chunk.replace(/^data: /gm, "");
				buffer += chunk;

				while (true) {
					const endOfObject = buffer.indexOf("\n");
					if (endOfObject === -1) {
						break;
					}

					const jsonString = buffer.substring(0, endOfObject);
					buffer = buffer.substring(endOfObject + 1);

					try {
						const json = JSON.parse(jsonString);
						if (
							json.choices &&
							json.choices.length > 0 &&
							json.choices[0].delta
						) {
							const text = json.choices[0].delta.content;
							editor.replaceSelection(text);
						}
					} catch (e) {
						console.error("Error parsing JSON", e);
					}
				}
			}
		} catch (error) {
			console.error("Error reading from stream", error);
		} finally {
			if (this.streamReader) {
				this.streamReader.cancel();
				this.streamReader = null;
			}
			this.isStreaming = false;
		}
	}

	stopStreaming() {
		if (this.streamReader) {
			this.streamReader.cancel();
			this.streamReader = null;
		}
		this.isStreaming = false;
		new Notice("Streaming stopped.");
	}
	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	displaySettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Temperature")
			.setDesc(
				"Controls randomness: lower values make responses more deterministic."
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.0, 2.0, 1.0)
					.setValue(this.settings.temperature)
					.onChange(async (value) => {
						this.settings.temperature = value;
						await this.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Frequency Penalty")
			.setDesc(
				"Higher values make the model less likely to repeat topics."
			)
			.addSlider((slider) =>
				slider
					.setLimits(-2.0, 2.0, 0.0)
					.setValue(this.settings.frequencyPenalty)
					.onChange(async (value) => {
						this.settings.frequencyPenalty = value;
						await this.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Presence Penalty")
			.setDesc(
				"Higher values make the model more likely to talk about new topics."
			)
			.addSlider((slider) =>
				slider
					.setLimits(-2.0, 2.0, 0.0)
					.setValue(this.settings.presencePenalty)
					.onChange(async (value) => {
						this.settings.presencePenalty = value;
						await this.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("top_p")
			.setDesc(
				"Also controls randomness: lower values make responses more deterministic."
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.0, 2.0, 1.0)
					.setValue(this.settings.temperature)
					.onChange(async (value) => {
						this.settings.temperature = value;
						await this.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max Tokens")
			.setDesc("Maximum number of tokens to generate.")
			.addText((text) =>
				text
					.setValue(String(this.settings.maxTokens))
					.onChange(async (value) => {
						this.settings.maxTokens = parseInt(value);
						await this.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("OpenAI API Key")
			.setDesc("Enter your OpenAI API key here.")
			.addText((text) =>
				text
					.setPlaceholder("Enter your API key")
					.setValue(this.settings.openAiApiKey)
					.onChange(async (value) => {
						this.settings.openAiApiKey = value;
						await this.saveSettings();
					})
			);
	}
}

class OpenAiSettingTab extends PluginSettingTab {
	plugin: JujunautAiPlugin;

	constructor(app: App, plugin: JujunautAiPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.plugin.displaySettings(containerEl);
	}
}
