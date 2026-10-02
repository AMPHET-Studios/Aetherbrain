using UnrealBuildTool;

public class AetherBrain : ModuleRules
{
	public AetherBrain(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "InputCore", "HTTP" });
		PrivateDependencyModuleNames.AddRange(new string[] { "Json" });
	}
}
