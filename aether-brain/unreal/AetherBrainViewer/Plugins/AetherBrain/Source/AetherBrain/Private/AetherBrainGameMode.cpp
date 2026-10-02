#include "AetherBrainGameMode.h"

#include "AetherBrainActor.h"
#include "AetherBrainHUD.h"
#include "AetherBrainPawn.h"
#include "AetherBrainPlayerController.h"
#include "Engine/PostProcessVolume.h"
#include "Engine/World.h"
#include "EngineUtils.h"

AAetherBrainGameMode::AAetherBrainGameMode()
{
	DefaultPawnClass = AAetherBrainPawn::StaticClass();
	PlayerControllerClass = AAetherBrainPlayerController::StaticClass();
	HUDClass = AAetherBrainHUD::StaticClass();
}

void AAetherBrainGameMode::StartPlay()
{
	Super::StartPlay();
	UWorld* World = GetWorld();
	if (!World)
	{
		return;
	}

	// The brain itself, unless the level already has one (placed by hand to change its settings).
	bool bHasBrain = false;
	for (TActorIterator<AAetherBrainActor> It(World); It; ++It)
	{
		bHasBrain = true;
		break;
	}
	if (!bHasBrain)
	{
		World->SpawnActor<AAetherBrainActor>(FVector::ZeroVector, FRotator::ZeroRotator);
	}

	// The stage: no sky, no sun, fixed exposure (glows stay as bright as the brain draws them), bloom.
	bool bHasStage = false;
	for (TActorIterator<APostProcessVolume> It(World); It; ++It)
	{
		bHasStage = true;
		break;
	}
	if (!bHasStage)
	{
		APostProcessVolume* Stage = World->SpawnActor<APostProcessVolume>(FVector::ZeroVector, FRotator::ZeroRotator);
		if (Stage)
		{
			Stage->bUnbound = true;
			FPostProcessSettings& S = Stage->Settings;
			S.bOverride_AutoExposureMinBrightness = true;
			S.AutoExposureMinBrightness = 0.f;
			S.bOverride_AutoExposureMaxBrightness = true;
			S.AutoExposureMaxBrightness = 0.f;
			S.bOverride_BloomIntensity = true;
			S.BloomIntensity = BloomIntensity;
			S.bOverride_VignetteIntensity = true;
			S.VignetteIntensity = 0.35f;
		}
	}
}
