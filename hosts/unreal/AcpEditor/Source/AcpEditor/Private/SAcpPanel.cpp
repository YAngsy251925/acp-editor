// Copyright (c) 2026. Licensed under the Apache License, Version 2.0.

#include "SAcpPanel.h"

#include "AcpEditorModule.h"

#include "Async/Async.h"
#include "IWebBrowserWindow.h"
#include "SWebBrowser.h"
#include "WebBrowserModule.h"

void SAcpPanel::Construct(const FArguments& InArgs)
{
	PanelOrigin = FAcpEditorModule::GetVirtualOrigin();
	PanelHtml = FAcpEditorModule::LoadPanelHtml();

	const FString HubUrl = FAcpEditorModule::GetHubUrl();
	const FString StartUrl = FString::Printf(TEXT("%s/index.html?hub=%s"), *PanelOrigin, *HubUrl);

	// SWebBrowserView silently creates no browser unless the WebBrowser module is
	// already loaded (IsAvailable only checks, nothing else in 5.8 loads it for
	// us), so force the load here — CEF initialises as part of it.
	IWebBrowserModule::Get();

	UE_LOG(LogTemp, Log, TEXT("[AcpEditor] panel start url: %s (html %d chars)"), *StartUrl, PanelHtml.Len());

	ChildSlot
	[
		SAssignNew(Browser, SWebBrowser)
			.InitialURL(StartUrl)
			.ShowControls(false)
			.ShowErrorMessage(false)
			.SupportsTransparency(false)
			// Serve the panel document from memory.
			.OnLoadUrl_Lambda([this](const FString& Method, const FString& Url, FString& OutResponse) -> bool
			{
				return HandleLoadUrl(Method, Url, OutResponse);
			})
			// Never let the panel navigate away from its own origin (a middle-click
			// on a link used to turn Epic's own assistant panel into a browser).
			.OnBeforeNavigation_Lambda([this](const FString& Url, const FWebNavigationRequest& Request) -> bool
			{
				const bool bAllowed = Url.StartsWith(PanelOrigin) || Url.StartsWith(TEXT("about:"));
				return !bAllowed;
			})
			// Popups open nothing; keep everything inside this tab.
			.OnBeforePopup_Lambda([](FString Url, FString Frame) -> bool
			{
				return true;
			})
			// Without UE keyboard focus on the browser widget, every keystroke is
			// dropped and clicked text boxes never show a caret (input is focus-gated
			// in SWebBrowserView). Load callbacks can arrive off the game thread, so
			// re-focus asynchronously the way Epic's own assistant panel does.
			.OnLoadCompleted_Lambda([Weak = TWeakPtr<SWebBrowser>(Browser)]()
			{
				AsyncTask(ENamedThreads::GameThread, [Weak]()
				{
					if (const TSharedPtr<SWebBrowser> Browser = Weak.Pin();
						Browser.IsValid() && FSlateApplication::IsInitialized())
					{
						FSlateApplication::Get().SetKeyboardFocus(Browser, EFocusCause::SetDirectly);
					}
				});
			})
	];
}

bool SAcpPanel::HandleLoadUrl(const FString& Method, const FString& Url, FString& OutResponse)
{
	if (!Url.StartsWith(PanelOrigin))
	{
		return false;
	}

	OutResponse = PanelHtml;
	return true;
}
