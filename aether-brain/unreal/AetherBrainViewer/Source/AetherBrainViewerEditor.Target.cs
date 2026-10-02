using UnrealBuildTool;

public class AetherBrainViewerEditorTarget : TargetRules
{
	public AetherBrainViewerEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("AetherBrainViewer");
	}
}
