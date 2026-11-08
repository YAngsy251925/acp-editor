// Copyright (c) 2026. Licensed under the Apache License, Version 2.0.

#pragma once

#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"

class SWebBrowser;

/**
 * The whole panel: one CEF view showing the hub's web UI.
 *
 * The page is served from a virtual origin (http://acp.local) that never
 * touches the network — OnLoadUrl hands CEF the HTML straight from the plugin's
 * Resources folder. That keeps the panel working offline and avoids opening a
 * local port just to render UI.
 */
class SAcpPanel : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SAcpPanel) {}
	SLATE_END_ARGS()

	void Construct(const FArguments& InArgs);

private:
	/** Called when the browser tries to resolve a URL for our virtual origin. */
	bool HandleLoadUrl(const FString& Method, const FString& Url, FString& OutResponse);

	FString PanelHtml;
	FString PanelOrigin;
	TSharedPtr<SWebBrowser> Browser;
};
