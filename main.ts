import {
	App,
	Editor,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";

import { promises as fs } from "fs";
import * as path from "path";

interface JujunautAiSettings {
	frequencyPenalty: number;
	maxTokens: number;
	openAiApiKey: string;
	presencePenalty: number;
	temperature: number;
	topP: number;
	useBlockquote: boolean;
}

export type Prompt = {
	role: "system" | "user";
	content: string;
};

const DEFAULT_SETTINGS: JujunautAiSettings = {
	frequencyPenalty: 0,
	maxTokens: 4096,
	openAiApiKey: "",
	presencePenalty: 0,
	temperature: 1,
	topP: 0.95,
	useBlockquote: false, // Default to false
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

	parseJujunautFilesBlock(text: string): string[] {
		const blockRegex = /```jujunaut-files\s+([\s\S]*?)```/g;
		const match = blockRegex.exec(text);
		if (match) {
			return match[1]
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
		}
		return [];
	}

	async resolveAndReadFiles(
		filePaths: string[]
	): Promise<{ path: string; content: string }[]> {
		const filesContent = [];
		for (const filePath of filePaths) {
			const resolvedPath = this.resolvePath(filePath);
			try {
				const stats = await fs.stat(resolvedPath);
				if (stats.isDirectory()) {
					const entries = await fs.readdir(resolvedPath, {
						withFileTypes: true,
					});
					for (const entry of entries) {
						if (entry.isFile()) {
							const fullPath = path.join(
								resolvedPath,
								entry.name
							);
							const fileContent = await fs.readFile(
								fullPath,
								"utf8"
							);
							filesContent.push({
								path: fullPath,
								content: fileContent,
							});
						}
					}
				} else {
					const fileContent = await fs.readFile(resolvedPath, "utf8");
					filesContent.push({
						path: resolvedPath,
						content: fileContent,
					});
				}
			} catch (error) {
				console.error(
					`Error reading file or directory ${resolvedPath}: ${error}`
				);
			}
		}
		return filesContent;
	}

	// Update the resolvePath method to handle different types of paths
	resolvePath(filePath: string): string {
		// Handle home directory paths
		if (filePath.startsWith("~")) {
			filePath = path.join(
				process.env.HOME || process.env.USERPROFILE || "",
				filePath.slice(1)
			);
		}

		// Resolve relative paths
		if (!path.isAbsolute(filePath)) {
			filePath = path.resolve(
				//@ts-ignore
				this.app.vault.adapter.basePath,
				filePath
			);
		}

		return filePath;
	}

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

		const filePaths = this.parseJujunautFilesBlock(text);
		const filesContent = await this.resolveAndReadFiles(filePaths);

		const systemPrompts: Prompt[] = filesContent.map((file) => ({
			role: "system",
			content: `File: ${file.path}\n${file.content}`,
		}));

		await this.streamOpenAI(text, editor, systemPrompts);
	}
	async streamOpenAI(
		prompt: string,
		editor: Editor,
		systemPrompts: Prompt[]
	): Promise<void> {
		const apiKey = this.settings.openAiApiKey;
		const messages = [...systemPrompts, { role: "user", content: prompt }];

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
					messages,
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
			if (this.settings.useBlockquote) {
				editor.replaceSelection("> ");
			}
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
							let text = json.choices[0].delta.content;
							if (this.settings.useBlockquote) {
								text = text.split("\n").join("\n> ");
								editor.replaceSelection(text);
							} else {
								editor.replaceSelection(text);
							}
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

		new Setting(containerEl)
			.setName("Temperature")
			.setDesc(
				"Controls randomness: lower values make responses more deterministic."
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.0, 2.0, 0.01)
					.setValue(this.settings.temperature)
					.setDynamicTooltip()
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
					.setLimits(-2.0, 2.0, 0.01)
					.setValue(this.settings.frequencyPenalty)
					.setDynamicTooltip()
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
					.setLimits(-2.0, 2.0, 0.01)
					.setValue(this.settings.presencePenalty)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.settings.presencePenalty = value;
						await this.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("top_p")
			.setDesc(
				"Controls the cumulative probability for model responses, affecting randomness."
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.0, 1.0, 0.01) // Correcting this to a realistic range for top_p
					.setValue(this.settings.topP)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.settings.topP = value;
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
			.setName("Use Blockquote for Output")
			.setDesc("Toggle to wrap AI-generated text in blockquotes.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.settings.useBlockquote)
					.onChange(async (value) => {
						this.settings.useBlockquote = value;
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
