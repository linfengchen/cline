// kilocode_change new file

import * as vscode from "vscode"
import { StepfunHandler } from "../../api/providers/stepfun"
import { CodeContext, ContextGatherer } from "./ContextGatherer"
import { createDebouncedFn } from "./utils/createDebouncedFn"
import { AutocompleteDecorationAnimation } from "./AutocompleteDecorationAnimation"
import { isHumanEdit } from "./utils/EditDetectionUtils"
import { AutocompleteCache } from "./AutocompleteCache"
import { holeFillerStrategy } from "./strategies/holeFiller"
import { createInlineCompletionItem } from "./AutocompleteActions"
import { processTextInsertion } from "./utils/CompletionTextProcessor"
import { AutocompleteStatusBar } from "./AutocompleteStatusBar"
import { getAllExtensionState } from "../../core/storage/state"

export const UI_UPDATE_DEBOUNCE_MS = 300
export const BAIL_OUT_TOO_MANY_LINES_LIMIT = 500
export const MAX_COMPLETIONS_PER_CONTEXT = 10 // Per-given prefix/suffix lines, how many different per-line options to cache

/**
 * Sets up autocomplete with experiment flag checking.
 * This function periodically checks the experiment flag and registers/disposes
 * the autocomplete provider accordingly.
 */
export function registerAutocomplete(context: vscode.ExtensionContext): void {
	let autocompleteDisposable: vscode.Disposable | null = null
	let isCurrentlyEnabled = false
	let currentConfigId: string | undefined = undefined

	const checkAndUpdateProvider = () => {
		/*
		const experiments =
			(ContextProxy.instance?.getGlobalState("experiments") as Record<ExperimentId, boolean>) ?? {}
		const shouldBeEnabled = experiments[EXPERIMENT_IDS.AUTOCOMPLETE] ?? true
		const newConfigId = ContextProxy.instance?.getValues?.()?.autocompleteApiConfigId

		const experimentChanged = true !== isCurrentlyEnabled
		const configChanged = newConfigId !== currentConfigId
		*/

		if (!isCurrentlyEnabled) {
			autocompleteDisposable?.dispose()
			autocompleteDisposable = setupAutocomplete(context)

			isCurrentlyEnabled = true
			//  currentConfigId = newConfigId
			console.log(`[Autocomplete] create success`)
		}
	}

	checkAndUpdateProvider()
	const experimentCheckInterval = setInterval(checkAndUpdateProvider, 5000)

	// Make sure to clean up the interval when the extension is deactivated
	context.subscriptions.push({
		dispose: () => {
			console.log(`[Autocomplete] destroyed`)
			clearInterval(experimentCheckInterval)
			autocompleteDisposable?.dispose()
		},
	})
}

function setupAutocomplete(context: vscode.ExtensionContext): vscode.Disposable {
	let enabled = true
	let activeRequestId: string | null = null
	let isBackspaceOperation = false
	let justAcceptedSuggestion = false
	let lastCompletionCost = 0
	let totalSessionCost = 0

	let apiHandler: StepfunHandler | null = null
	const autocompleteCache = new AutocompleteCache()
	const contextGatherer = new ContextGatherer()
	const animationManager = AutocompleteDecorationAnimation.getInstance()
	const statusBar = new AutocompleteStatusBar({ enabled })

	const updateStatusBar = () => {
		statusBar.update({
			enabled,
			totalSessionCost,
			lastCompletionCost,
			model: apiHandler?.getModel().id || "default",
			hasValidToken: apiHandler !== null,
		})
		console.log(`[Autocomplete] status updated: ${apiHandler}`)
	}

	const updateApiHandler = async (context: vscode.ExtensionContext) => {
		try {
			// Get API configuration
			const { apiConfiguration } = await getAllExtensionState(context)
			if (!apiConfiguration) {
				console.error(`[Autocomplete] status updated: ${apiConfiguration}`)
				return
			}
			// Build API handler
			apiHandler = new StepfunHandler(apiConfiguration)
			apiHandler.setAutoCompleteModel("step-2-mini")
		} catch (error) {
			console.warn("Failed to update autocomplete API handler:", error)
			apiHandler = null
		}
		updateStatusBar() // Update status bar with new model and token validity
	}

	const clearState = () => {
		vscode.commands.executeCommand("editor.action.inlineSuggest.hide")
		animationManager.stopAnimation()

		isBackspaceOperation = false
		justAcceptedSuggestion = false
		activeRequestId = null
	}

	const generateCompletion = async ({
		codeContext,
		document,
		position,
	}: {
		codeContext: CodeContext
		document: vscode.TextDocument
		position: vscode.Position
	}) => {
		if (!apiHandler) throw new Error("apiHandler must be set before calling generateCompletion!")

		const requestId = crypto.randomUUID()
		activeRequestId = requestId
		// animationManager.startAnimation()

		const { systemPrompt, userPrompt } = holeFillerStrategy.getCompletionPrompts(document, position, codeContext)

		console.log(`🚀🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶\n`, userPrompt)

		const stream = apiHandler.createMessage(systemPrompt, [{ role: "user", content: [{ type: "text", text: userPrompt }] }])

		let completion = ""
		let processedCompletion = ""
		let lineCount = 0
		let completionCost = 0

		try {
			for await (const chunk of stream) {
				if (activeRequestId !== requestId) {
					break // This request is no longer active
				}

				if (chunk.type === "text") {
					completion += chunk.text
					processedCompletion = holeFillerStrategy.parseResponse(completion)
					lineCount += processedCompletion.split("/n").length
				} else if (chunk.type === "usage") {
					completionCost = chunk.totalCost ?? 0
				}

				if (lineCount > BAIL_OUT_TOO_MANY_LINES_LIMIT) {
					processedCompletion = ""
					break
				}
			}
		} catch (error) {
			console.error("Error streaming completion:", error)
			processedCompletion = ""
		}

		// Update cost tracking variables
		totalSessionCost += completionCost
		lastCompletionCost = completionCost
		updateStatusBar()

		if (activeRequestId === requestId) {
			// animationManager.stopAnimation()
		}

		return { processedCompletion, lineCount, cost: completionCost }
	}

	const debouncedGenerateCompletion = createDebouncedFn(generateCompletion, UI_UPDATE_DEBOUNCE_MS)

	const provider: vscode.InlineCompletionItemProvider = {
		async provideInlineCompletionItems(document, position, context, token) {
			if (!enabled || !vscode.window.activeTextEditor || !apiHandler) return null

			// Skip providing completions if this was triggered by a backspace operation of if we just accepted a suggestion
			if (isBackspaceOperation || justAcceptedSuggestion) {
				console.log(`[Autocomplete] Skipping due to backspace or accepted suggestion`)
				return null
			}

			// Check if we're at the start of a line with only whitespace before cursor
			const lineText = document.lineAt(position.line).text
			const textBeforeCursor = lineText.substring(0, position.character)

			// Allow autocomplete even in whitespace at start of line for better UX
			// Only skip if it's pure whitespace at the very start of the file
			if (textBeforeCursor.trim() === "" && position.character === 0 && position.line === 0) {
				console.log(`[Autocomplete] Skipping autocomplete at start of file`)
				return null
			}

			// Get exactly what's been typed on the current line
			const linePrefix = document.getText(new vscode.Range(new vscode.Position(position.line, 0), position)).trimStart()
			console.log(`🚀🛑 Autocomplete for line with prefix: "${linePrefix}"!`)

			const codeContext = await contextGatherer.gatherContext(document, position, true, true)
			console.log(
				`[Autocomplete] Context gathered - definitions: ${codeContext.definitions.length}, imports: ${codeContext.imports.length}`,
			)

			// Check if we have a cached completion for this context
			const cachedCompletions = autocompleteCache.getByContext(codeContext) ?? []
			for (const completion of cachedCompletions) {
				if (completion.startsWith(linePrefix)) {
					const processedResult = processTextInsertion({ document, position, textToInsert: completion })
					if (processedResult) {
						console.log(
							`🚀🎯 Using cached completion '${processedResult.processedText}' (${cachedCompletions.length} options)`,
						)
						animationManager.stopAnimation()
						return [createInlineCompletionItem(processedResult.processedText, processedResult.insertRange)]
					}
				}
			}

			const generationResult = await debouncedGenerateCompletion({ document, codeContext, position })
			if (!generationResult || token.isCancellationRequested) {
				console.log(`[Autocomplete] Generation failed or cancelled`)
				return null
			}
			const { processedCompletion, cost } = generationResult
			console.log(`[Autocomplete] Generated completion:`, {
				length: processedCompletion.length,
				cost: cost,
				preview: processedCompletion.substring(0, 50) + (processedCompletion.length > 50 ? "..." : ""),
			})

			// Cache the successful completion for future use
			if (processedCompletion) {
				const completions = autocompleteCache.getByContext(codeContext) ?? []

				// Add the new completion if it's not already in the list
				if (!completions.includes(processedCompletion)) {
					completions.push(linePrefix + processedCompletion)
					console.log(`🚀🛑 Saved new cache entry '${linePrefix + processedCompletion}'`)

					// Prune the array if it exceeds the maximum size
					// Keep the most recent completions (remove from the beginning)
					if (completions.length > MAX_COMPLETIONS_PER_CONTEXT) {
						completions.splice(0, completions.length - MAX_COMPLETIONS_PER_CONTEXT)
					}
				}
				autocompleteCache.setByContext(codeContext, completions)
			}

			const processedResult = processTextInsertion({ document, position, textToInsert: processedCompletion })
			if (processedResult) {
				return [createInlineCompletionItem(processedResult.processedText, processedResult.insertRange)]
			}
			return null
		},
	}

	// Register provider and commands
	const providerDisposable = vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider)

	const toggleCommand = vscode.commands.registerCommand("stepcline.toggleAutocomplete", () => {
		enabled = !enabled
		updateStatusBar()
		vscode.window.showInformationMessage(
			`"kilocode:autocomplete.toggleMessage", { status: enabled ? "enabled" : "disabled" }`,
		)
	})

	// Command to track when a suggestion is accepted
	const trackAcceptedSuggestionCommand = vscode.commands.registerCommand("stepcline.trackAcceptedSuggestion", () => {
		justAcceptedSuggestion = true
	})

	// Event handlers
	const selectionHandler = vscode.window.onDidChangeTextEditorSelection((_e) => {
		// Reset the flag when selection changes
		// This ensures we only skip one completion request after accepting a suggestion
		justAcceptedSuggestion = false
	})
	const documentHandler = vscode.workspace.onDidChangeTextDocument((e) => {
		const editor = vscode.window.activeTextEditor
		if (!editor || editor.document !== e.document || !e.contentChanges.length) {
			console.log(`[Autocomplete] document change, ${editor !== null}, content:${e.contentChanges}`)
			return
		}

		clearState()

		// Check if this edit is from human typing rather than AI tools, copy-paste, etc.
		// Only trigger autocomplete for human edits to avoid interference
		const isHumanTyping = isHumanEdit(e)
		if (!isHumanTyping) {
			console.log("🚀🤖 Skipping autocomplete trigger during non-human edit")
			return
		}

		// Reset the justAcceptedSuggestion flag when the user makes any edit
		// This ensures we only skip one completion request after accepting a suggestion
		justAcceptedSuggestion = false

		// Detect backspace operations by checking content changes
		const change = e.contentChanges[0]
		if (change.rangeLength > 0 && change.text === "") {
			isBackspaceOperation = true
		}

		// Force inlineSuggestions to appear, even for whitespace changes
		// without this, hitting keys like spacebar won't show the completion
		vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")
	})

	// Create a composite disposable to return
	const disposable = new vscode.Disposable(() => {
		providerDisposable.dispose()
		toggleCommand.dispose()
		trackAcceptedSuggestionCommand.dispose()
		statusBar.dispose()
		selectionHandler.dispose()
		documentHandler.dispose()
		animationManager.dispose()
	})

	// Still register with context for safety
	context.subscriptions.push(disposable)

	// Initialize the handler and status bar
	updateApiHandler(context).catch((error) => {
		console.warn("Failed to initialize autocomplete API handler:", error)
	})
	updateStatusBar()

	return disposable
}
