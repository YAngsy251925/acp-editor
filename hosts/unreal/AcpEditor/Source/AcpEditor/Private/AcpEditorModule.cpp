// Copyright (c) 2026. Licensed under the Apache License, Version 2.0.

#include "AcpEditorModule.h"

#include "SAcpPanel.h"

#include "Framework/Application/SlateApplication.h"
#include "Framework/Docking/TabManager.h"
#include "Interfaces/IPluginManager.h"
#include "Interfaces/IMainFrameModule.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/CoreDelegates.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "StatusBarSubsystem.h"
#include "ToolMenus.h"
#include "Widgets/Docking/SDockTab.h"
#include "Widgets/SWindow.h"

#define LOCTEXT_NAMESPACE "FAcpEditorModule"

static const FName AcpChatTabName("AcpChat");

FName FAcpEditorModule::GetTabName()
{
	return AcpChatTabName;
}

FString FAcpEditorModule::GetVirtualOrigin()
{
	return TEXT("http://acp.local");
}

FString FAcpEditorModule::GetHubUrl()
{
	FString Url;
	if (GConfig && GConfig->GetString(TEXT("ACPChat"), TEXT("HubUrl"), Url, GEditorPerProjectIni))
	{
		Url.TrimStartAndEndInline();
	}
	if (Url.IsEmpty())
	{
		Url = TEXT("http://127.0.0.1:7878");
	}
	// Strip a trailing slash so the page can append paths uniformly.
	while (Url.EndsWith(TEXT("/")))
	{
		Url.LeftChopInline(1);
	}
	return Url;
}

FString FAcpEditorModule::LoadPanelHtml()
{
	if (const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("AcpEditor")))
	{
		const FString HtmlPath = FPaths::Combine(
			Plugin->GetBaseDir(), TEXT("Resources"), TEXT("web"), TEXT("index.html"));

		FString Html;
		if (FFileHelper::LoadFileToString(Html, *HtmlPath))
		{
			return Html;
		}

		UE_LOG(LogTemp, Error, TEXT("[AcpEditor] missing panel html: %s"), *HtmlPath);
		return FString::Printf(
			TEXT("<html><body style='font-family:sans-serif;background:#1b1b1f;color:#e6e6e6;padding:24px'>"
				 "<h2>ACP Editor</h2><p>Panel asset not found:</p><pre>%s</pre></body></html>"),
			*HtmlPath);
	}

	return TEXT("<html><body style='background:#1b1b1f;color:#e6e6e6;padding:24px'>"
				"<h2>ACP Editor</h2><p>Plugin not found by IPluginManager.</p></body></html>");
}

void FAcpEditorModule::StartupModule()
{
	FGlobalTabmanager::Get()
		->RegisterNomadTabSpawner(
			AcpChatTabName,
			FOnSpawnTab::CreateRaw(this, &FAcpEditorModule::SpawnTab))
		.SetDisplayName(LOCTEXT("AcpChatTab", "ACP Chat"))
		.SetTooltipText(LOCTEXT("AcpChatTabTooltip", "Chat with an ACP agent (hub runs outside the editor)"))
		.SetMenuType(ETabSpawnerMenuType::Hidden);

	ToolsMenuStartupHandle = UToolMenus::RegisterStartupCallback(
		FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FAcpEditorModule::RegisterMenus));

	RegisterStatusBarSummon();

	// Optionally summon the panel on editor start. The browser control needs the
	// main window to exist: opening it earlier leaves CEF uninitialised and the
	// panel a blank grey rectangle that never recovers. So anchor the auto-open
	// to main-frame creation instead of guessing a tick delay.
	bool bAutoOpen = true;
	if (GConfig)
	{
		GConfig->GetBool(TEXT("ACPChat"), TEXT("AutoOpen"), bAutoOpen, GEditorPerProjectIni);
	}
	if (bAutoOpen)
	{
		IMainFrameModule& MainFrame = FModuleManager::LoadModuleChecked<IMainFrameModule>(TEXT("MainFrame"));
		if (MainFrame.IsWindowInitialized())
		{
			// Loaded into a running editor (Live Coding): the window already exists.
			OpenPanelInDrawer();
		}
		else
		{
			MainFrameCreationHandle = MainFrame.OnMainFrameCreationFinished().AddLambda(
				[](TSharedPtr<SWindow> /*ParentWindow*/, bool /*bIsStartupDialog*/)
				{
					FAcpEditorModule::OpenPanelInDrawer();
				});
		}
	}
}

void FAcpEditorModule::OpenPanelInDrawer()
{
	// TryInvokeTab alone spawns a *floating* NomadTab, which lands behind other
	// windows and looks broken. Ask the main window's tab manager for the panel
	// drawer instead, the same way Epic's own assistant panel docks itself.
	TSharedPtr<SWindow> TargetWindow = FGlobalTabmanager::Get()->GetRootWindow();
	if (!TargetWindow.IsValid())
	{
		TargetWindow = FSlateApplication::Get().GetActiveTopLevelWindow();
	}

	if (TargetWindow.IsValid())
	{
		if (TSharedPtr<FTabManager> TabManager =
				FGlobalTabmanager::Get()->GetSubTabManagerForWindow(TargetWindow.ToSharedRef()))
		{
			// Parent window left null so the drawer uses the primary area.
			TabManager->TryOpenTabInPanelDrawer(AcpChatTabName, nullptr);
			return;
		}
	}

	// Fallback: plain invoke (floating window).
	FGlobalTabmanager::Get()->TryInvokeTab(AcpChatTabName);
}

void FAcpEditorModule::ShutdownModule()
{
	UnregisterStatusBarSummon();

	if (MainFrameCreationHandle.IsValid())
	{
		if (FModuleManager::Get().IsModuleLoaded(TEXT("MainFrame")))
		{
			IMainFrameModule::Get().OnMainFrameCreationFinished().Remove(MainFrameCreationHandle);
		}
		MainFrameCreationHandle.Reset();
	}

	UToolMenus::UnRegisterStartupCallback(this);
	UToolMenus::UnregisterOwner(this);

	if (FSlateApplication::IsInitialized())
	{
		FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(AcpChatTabName);
	}
}

void FAcpEditorModule::RegisterStatusBarSummon()
{
	if (!GEditor)
	{
		// While editor plugins load the editor subsystems do not exist yet. Come
		// back once the engine is up; registering here would silently do nothing.
		if (!PostEngineInitHandle.IsValid())
		{
			PostEngineInitHandle = FCoreDelegates::OnPostEngineInit.AddRaw(
				this, &FAcpEditorModule::RegisterStatusBarSummon);
		}
		return;
	}

	// The StatusBar module may not be loaded yet; force it so the subsystem exists.
	FModuleManager::Get().LoadModuleChecked(TEXT("StatusBar"));

	if (UStatusBarSubsystem* StatusBar = GEditor->GetEditorSubsystem<UStatusBarSubsystem>())
	{
		StatusBarSummonHandle = StatusBar->RegisterPanelDrawerSummon(
			UStatusBarSubsystem::FRegisterPanelDrawerSummonDelegate::FDelegate::CreateLambda(
				[](TArray<UStatusBarSubsystem::FTabIdAndButtonLabel>& OutEntries,
				   const TSharedRef<SDockTab>& /*InParentTab*/)
				{
					OutEntries.Emplace(
						FAcpEditorModule::GetTabName(),
						NSLOCTEXT("AcpEditor", "StatusBarSummon", "ACP Chat"));
				}));
	}
}

void FAcpEditorModule::UnregisterStatusBarSummon()
{
	if (PostEngineInitHandle.IsValid())
	{
		FCoreDelegates::OnPostEngineInit.Remove(PostEngineInitHandle);
		PostEngineInitHandle.Reset();
	}

	if (!GEditor || !StatusBarSummonHandle.IsValid())
	{
		return;
	}

	if (UStatusBarSubsystem* StatusBar = GEditor->GetEditorSubsystem<UStatusBarSubsystem>())
	{
		StatusBar->UnregisterPanelDrawerSummon(StatusBarSummonHandle);
	}
	StatusBarSummonHandle.Reset();
}

void FAcpEditorModule::RegisterMenus()
{
	FToolMenuOwnerScoped OwnerScoped(this);

	if (UToolMenu* WindowMenu = UToolMenus::Get()->ExtendMenu(TEXT("MainFrame.MainMenu.Window")))
	{
		FToolMenuSection& Section = WindowMenu->FindOrAddSection(
			TEXT("Assistance"), LOCTEXT("AssistanceSection", "Assistance"));

		Section.AddMenuEntry(
			TEXT("OpenAcpChat"),
			LOCTEXT("OpenAcpChat", "ACP Chat"),
			LOCTEXT("OpenAcpChatTooltip", "Open the ACP chat panel"),
			FSlateIcon(),
			FUIAction(FExecuteAction::CreateLambda([]()
			{
				FAcpEditorModule::OpenPanelInDrawer();
			})));
	}
}

TSharedRef<SDockTab> FAcpEditorModule::SpawnTab(const FSpawnTabArgs& Args)
{
	return SNew(SDockTab)
		.TabRole(ETabRole::NomadTab)
		.Label(LOCTEXT("AcpChatTab", "ACP Chat"))
		[
			SNew(SAcpPanel)
		];
}

#undef LOCTEXT_NAMESPACE

IMPLEMENT_MODULE(FAcpEditorModule, AcpEditor)
