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

	/** Fill the level with space (stars, nebulae, galaxies, asteroids, ships) unless it already has one. */
	UPROPERTY(EditAnywhere, Category = "Aether Brain")
	bool bSpawnSpace = true;

	/** The voyage: photographic sky and suns, ships, folder pictures, and the flight to a folder (V) unless the level already has the actor. */
	UPROPERTY(EditAnywhere, Category = "Aether Brain")
	bool bSpawnVoyage = true;

	/** Play the Niagara effects (light along the links, coronas, ripples, dust, shooting stars) unless the level already has the actor. */
	UPROPERTY(EditAnywhere, Category = "Aether Brain")
	bool bSpawnFx = true;

	/** Bloom strength of the stage's post process. */
	UPROPERTY(EditAnywhere, Category = "Aether Brain")
	float BloomIntensity = 1.4f;
};
