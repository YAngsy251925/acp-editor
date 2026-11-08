// Copyright (c) 2026. Licensed under the Apache License, Version 2.0.

using UnrealBuildTool;

public class AcpEditor : ModuleRules
{
	public AcpEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
		});

		PrivateDependencyModuleNames.AddRange(new string[]
		{
			"Slate",
			"SlateCore",
			"UnrealEd",
			"ToolMenus",
			"Projects",
			"InputCore",
			"ApplicationCore",
			// Status bar button ("ACP Chat") next to Epic's "Ask AI".
			"StatusBar",
			// Auto-open the panel once the main editor window exists.
			"MainFrame",
			// CEF panel. WebBrowser is a runtime module (Engine/Source/Runtime/WebBrowser).
			"WebBrowser",
			"Json",
			"JsonUtilities",
		});
	}
}
