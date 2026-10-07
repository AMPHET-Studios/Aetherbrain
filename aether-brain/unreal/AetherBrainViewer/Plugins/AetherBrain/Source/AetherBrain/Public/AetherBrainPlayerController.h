// Flying through the brain: hold the right mouse button to look, WASD to fly (Q / E down / up, Shift faster,
// the wheel sets the speed), click a node to select it (the desktop app flies there too), double-click or
// Enter to open it in the desktop app, F to fly to the selection, H to see everything, Tab for the next star,
// B to cycle the space around the brain (full, calm, off), N to switch the Niagara effects on and off.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerController.h"
#include "AetherBrainPlayerController.generated.h"

class AAetherBrainActor;
class AAetherFxActor;
class AAetherSpaceActor;

UCLASS()
class AETHERBRAIN_API AAetherBrainPlayerController : public APlayerController
{
	GENERATED_BODY()

public:
	AAetherBrainPlayerController();

	/** cm per second at speed step 0. */
	UPROPERTY(EditAnywhere, Category = "Aether Brain")
	float BaseSpeed = 1200.f;

	/** Degrees per mouse step while looking. */
	UPROPERTY(EditAnywhere, Category = "Aether Brain")
	float LookSensitivity = 0.15f;

	AAetherBrainActor* GetBrain() const { return Brain.Get(); }
	AAetherSpaceActor* GetSpace() const { return Space.Get(); }
	AAetherFxActor* GetFx() const { return Fx.Get(); }
	int32 GetHovered() const { return Hovered; }
	float GetSpeed() const;

	/** Fly the camera to frame a node. */
	void FlyToNode(int32 Index);
	/** Fly the camera back to see the whole brain. */
	void FlyHome();

protected:
	virtual void BeginPlay() override;
	virtual void PlayerTick(float DeltaTime) override;

private:
	void FlyTo(const FVector& Location, const FRotator& Rotation);
	void Look(float DeltaTime);
	void Move(float DeltaTime);
	void PickAndClick();
	void Keys();

	TWeakObjectPtr<AAetherBrainActor> Brain;
	TWeakObjectPtr<AAetherSpaceActor> Space;
	TWeakObjectPtr<AAetherFxActor> Fx;
	FVector CamLocation = FVector(-3000.0, 0.0, 600.0);
	FRotator CamRotation = FRotator(-10.0, 0.0, 0.0);
	int32 SpeedStep = 0;
	int32 Hovered = INDEX_NONE;
	int32 LastClicked = INDEX_NONE;
	double LastClickTime = 0.0;
	FVector2D LastMouse = FVector2D::ZeroVector;
	bool bWasLooking = false;

	bool bFlying = false;
	float FlyT = 0.f;
	FVector FlyFromLocation = FVector::ZeroVector;
	FRotator FlyFromRotation = FRotator::ZeroRotator;
	FVector FlyToLocation = FVector::ZeroVector;
	FRotator FlyToRotation = FRotator::ZeroRotator;
};
