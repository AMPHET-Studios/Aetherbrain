// Sets the viewer up in any level: the brain, the camera, the controls, a space-black stage with bloom.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "AetherBrainGameMode.generated.h"

UCLASS()
class AETHERBRAIN_API AAetherBrainGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	AAetherBrainGameMode();

	virtual void StartPlay() override;

	/** Bloom strength of the stage's post process. */
	UPROPERTY(EditAnywhere, Category = "Aether Brain")
	float BloomIntensity = 1.4f;
};
