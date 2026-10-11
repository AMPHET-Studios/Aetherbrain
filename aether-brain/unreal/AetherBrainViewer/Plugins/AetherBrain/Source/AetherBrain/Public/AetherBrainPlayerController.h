// Flying through the brain: hold the right mouse button to look, WASD to fly (Q / E down / up, Shift faster,
// the wheel sets the speed), click a node to select it (the desktop app flies there too), double-click or
// Enter to open it in the desktop app, F to fly to the selection, H to see everything, Tab for the next star,
// B to cycle the space around the brain (full, calm, off), N to switch the Niagara effects on and off.
// V flies the interceptor to the selected folder through asteroid fields (A / D / Q / E steer, W / S throttle, hold the left mouse
// button or Space to fire where the cursor points, Enter opens the folder when you arrive, V or Esc leaves).
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerController.h"
#include "AetherBrainPlayerController.generated.h"

class AAetherBrainActor;
class AAetherFxActor;
class AAetherSpaceActor;
class AAetherVoyageActor;

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
	AAetherVoyageActor* GetVoyage() const { return Voyage.Get(); }
	/** What the last V press said when it did not fly ("Select a folder first"), for the HUD, and until when. */
	const FString& GetVoyageNote() const { return VoyageNote; }
	bool HasVoyageNote() const;
	float GetThrottle() const { return Throttle; }
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
	/** V: fly to the selected folder (or the hovered one, or the one most in front). */
	void StartVoyage();
	void LeaveVoyage();
	/** One frame of a voyage: the player's input to the actor, the chase camera back. */
	void VoyageTick(float DeltaTime);
	int32 ChooseVoyageTarget() const;

	TWeakObjectPtr<AAetherBrainActor> Brain;
	TWeakObjectPtr<AAetherSpaceActor> Space;
	TWeakObjectPtr<AAetherFxActor> Fx;
	TWeakObjectPtr<AAetherVoyageActor> Voyage;
	FString VoyageNote;
	double VoyageNoteUntil = 0.0;
	float Throttle = 1.f;
	float FovBeforeVoyage = 90.f;
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
