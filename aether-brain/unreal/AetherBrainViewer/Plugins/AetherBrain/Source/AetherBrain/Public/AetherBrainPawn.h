// The viewer's camera: a pawn that is only a camera. The player controller moves it (no input assets needed).
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"
#include "AetherBrainPawn.generated.h"

class UCameraComponent;

UCLASS()
class AETHERBRAIN_API AAetherBrainPawn : public APawn
{
	GENERATED_BODY()

public:
	AAetherBrainPawn();

	UPROPERTY(VisibleAnywhere, Category = "Aether Brain")
	TObjectPtr<USceneComponent> Root;

	UPROPERTY(VisibleAnywhere, Category = "Aether Brain")
	TObjectPtr<UCameraComponent> Camera;
};
