using UnrealBuildTool;

public class AetherBrainViewerTarget : TargetRules
{
	public AetherBrainViewerTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("AetherBrainViewer");
	}
}
