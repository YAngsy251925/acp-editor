// Copyright (c) 2026. Licensed under the Apache License, Version 2.0.

#pragma once

#include "CoreMinimal.h"
#include "Modules/ModuleInterface.h"

class FSpawnTabArgs;
class SDockTab;

/**
 * Editor host for the ACP chat panel.
 *
 * The plugin is deliberately thin: it owns a dock tab, an embedded CEF view,
 * and nothing else. All protocol work lives in the external hub process
 * (packages/hub), so the editor never links against agent code and an agent
 * crash cannot take the editor down.
 */
class FAcpEditorModule : public IModuleInterface
{
public:
	virtual void StartupModule() override;
	virtual void ShutdownModule() override;

	/** Tab id used for RegisterNomadTabSpawner. */
	static FName GetTabName();

	/** Raw HTML for the panel (Resources/web/index.html inside the plugin). */
	static FString LoadPanelHtml();

	/** Hub base URL, e.g. http://127.0.0.1:7878 */
	static FString GetHubUrl();

	/** Virtual origin the embedded page is served from. Never hits the network. */
	static FString GetVirtualOrigin();

	/** Dock the panel into the main window's panel drawer (fallback: floating tab). */
	static void OpenPanelInDrawer();

private:
	void RegisterMenus();
	TSharedRef<SDockTab> SpawnTab(const FSpawnTabArgs& Args);

	/**
	 * Adds the "ACP Chat" button to the editor status bar (panel-drawer summon).
	 *
	 * Needs GEditor, which does not exist yet while editor plugins load, so the
	 * call is deferred to PostEngineInit in that case — the same thing Epic's
	 * AIAssistant does. Without the deferral the button silently never appears.
	 */
	void RegisterStatusBarSummon();
	void UnregisterStatusBarSummon();

	FDelegateHandle ToolsMenuStartupHandle;
	FDelegateHandle StatusBarSummonHandle;
	FDelegateHandle PostEngineInitHandle;
	FDelegateHandle MainFrameCreationHandle;
};
