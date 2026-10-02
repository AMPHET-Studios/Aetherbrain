using UnrealBuildTool;

// The project's own module: empty on purpose. Everything lives in the AetherBrain plugin (Plugins/AetherBrain).
public class AetherBrainViewer : ModuleRules
{
	public AetherBrainViewer(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine" });
	}
}
