#include "AetherBrainPlayerController.h"

#include "AetherBrainActor.h"
#include "EngineUtils.h"
#include "Engine/World.h"
#include "GameFramework/Pawn.h"
#include "InputCoreTypes.h"

namespace
{
	constexpr float FlySeconds = 0.9f;
	constexpr double DoubleClickSeconds = 0.35;

	float Ease(float T)
	{
		// Smoothstep: starts and lands gently.
		return T * T * (3.f - 2.f * T);
	}
}

AAetherBrainPlayerController::AAetherBrainPlayerController()
{
	bShowMouseCursor = true;
	bEnableClickEvents = false;
	bEnableMouseOverEvents = false;
	PrimaryActorTick.bCanEverTick = true;
}

void AAetherBrainPlayerController::BeginPlay()
{
	Super::BeginPlay();
	FInputModeGameAndUI Mode;
	Mode.SetHideCursorDuringCapture(true);
	Mode.SetLockMouseToViewportBehavior(EMouseLockMode::DoNotLock);
	SetInputMode(Mode);
	SetShowMouseCursor(true);
}

float AAetherBrainPlayerController::GetSpeed() const
{
	return BaseSpeed * FMath::Pow(1.35f, static_cast<float>(SpeedStep));
}

void AAetherBrainPlayerController::PlayerTick(float DeltaTime)
{
	Super::PlayerTick(DeltaTime);

	if (!Brain.IsValid() && GetWorld())
	{
		for (TActorIterator<AAetherBrainActor> It(GetWorld()); It; ++It)
		{
			Brain = *It;
			break;
		}
	}
	AAetherBrainActor* B = Brain.Get();
	if (B)
	{
		if (B->ConsumeFirstPositions())
		{
			FlyHome();
		}
		int32 FromBrain = INDEX_NONE;
		if (B->ConsumeBrainSelection(FromBrain))
		{
			FlyToNode(FromBrain);
		}
	}

	Look(DeltaTime);
	Move(DeltaTime);
	Keys();
	PickAndClick();

	if (bFlying)
	{
		FlyT = FMath::Min(1.f, FlyT + DeltaTime / FlySeconds);
		const float A = Ease(FlyT);
		CamLocation = FMath::Lerp(FlyFromLocation, FlyToLocation, static_cast<double>(A));
		CamRotation = FMath::Lerp(FlyFromRotation, FlyToRotation, A);
		bFlying = FlyT < 1.f;
	}
	if (APawn* P = GetPawn())
	{
		P->SetActorLocationAndRotation(CamLocation, CamRotation);
	}
}

void AAetherBrainPlayerController::Look(float DeltaTime)
{
	const bool bLooking = IsInputKeyDown(EKeys::RightMouseButton);
	float X = 0.f;
	float Y = 0.f;
	GetMousePosition(X, Y);
	const FVector2D Mouse(X, Y);
	if (bLooking)
	{
		float DX = 0.f;
		float DY = 0.f;
		GetInputMouseDelta(DX, DY);
		// No captured delta (some platforms while the cursor shows): use how far the cursor moved, in pixels.
		if (DX == 0.f && DY == 0.f && bWasLooking)
		{
			DX = static_cast<float>(Mouse.X - LastMouse.X) * 0.25f;
			DY = static_cast<float>(LastMouse.Y - Mouse.Y) * 0.25f;
		}
		if (DX != 0.f || DY != 0.f)
		{
			bFlying = false;
			CamRotation.Yaw += DX * LookSensitivity * 10.f;
			CamRotation.Pitch = FMath::Clamp(CamRotation.Pitch + DY * LookSensitivity * 10.f, -89.0, 89.0);
		}
	}
	bWasLooking = bLooking;
	LastMouse = Mouse;
}

void AAetherBrainPlayerController::Move(float DeltaTime)
{
	const float Forward = (IsInputKeyDown(EKeys::W) ? 1.f : 0.f) - (IsInputKeyDown(EKeys::S) ? 1.f : 0.f);
	const float Right = (IsInputKeyDown(EKeys::D) ? 1.f : 0.f) - (IsInputKeyDown(EKeys::A) ? 1.f : 0.f);
	const float Up = (IsInputKeyDown(EKeys::E) ? 1.f : 0.f) - (IsInputKeyDown(EKeys::Q) ? 1.f : 0.f);
	if (WasInputKeyJustPressed(EKeys::MouseScrollUp))
	{
		SpeedStep = FMath::Min(SpeedStep + 1, 14);
	}
	if (WasInputKeyJustPressed(EKeys::MouseScrollDown))
	{
		SpeedStep = FMath::Max(SpeedStep - 1, -10);
	}
	if (Forward == 0.f && Right == 0.f && Up == 0.f)
	{
		return;
	}
	bFlying = false;
	const bool bFast = IsInputKeyDown(EKeys::LeftShift) || IsInputKeyDown(EKeys::RightShift);
	const FRotationMatrix M(CamRotation);
	const FVector Dir = M.GetUnitAxis(EAxis::X) * Forward + M.GetUnitAxis(EAxis::Y) * Right + FVector::UpVector * Up;
	CamLocation += Dir.GetSafeNormal() * static_cast<double>(GetSpeed() * (bFast ? 4.f : 1.f) * DeltaTime);
}

void AAetherBrainPlayerController::Keys()
{
	AAetherBrainActor* B = Brain.Get();
	if (!B)
	{
		return;
	}
	if (WasInputKeyJustPressed(EKeys::H) || WasInputKeyJustPressed(EKeys::Home))
	{
		FlyHome();
	}
	if (WasInputKeyJustPressed(EKeys::F) && B->GetSelected() != INDEX_NONE)
	{
		FlyToNode(B->GetSelected());
	}
	if (WasInputKeyJustPressed(EKeys::Enter) && B->GetSelected() != INDEX_NONE)
	{
		B->SelectNode(B->GetSelected(), true);
	}
	if (WasInputKeyJustPressed(EKeys::Tab))
	{
		const int32 Star = B->NextStar(B->GetSelected());
		if (Star != INDEX_NONE)
		{
			B->SelectNode(Star, false);
			FlyToNode(Star);
		}
	}
}

void AAetherBrainPlayerController::PickAndClick()
{
	AAetherBrainActor* B = Brain.Get();
	if (!B)
	{
		return;
	}
	FVector Origin;
	FVector Direction;
	const bool bLooking = IsInputKeyDown(EKeys::RightMouseButton);
	Hovered = !bLooking && DeprojectMousePositionToWorld(Origin, Direction) ? B->Pick(Origin, Direction) : INDEX_NONE;
	B->SetHovered(Hovered);
	if (!WasInputKeyJustPressed(EKeys::LeftMouseButton) || Hovered == INDEX_NONE)
	{
		return;
	}
	const double Now = GetWorld() ? GetWorld()->GetRealTimeSeconds() : 0.0;
	const bool bDouble = Hovered == LastClicked && Now - LastClickTime < DoubleClickSeconds;
	LastClicked = Hovered;
	LastClickTime = Now;
	// A click selects (the desktop app flies there too); a double-click opens the note there.
	B->SelectNode(Hovered, bDouble);
	if (!bDouble)
	{
		FlyToNode(Hovered);
	}
}

void AAetherBrainPlayerController::FlyTo(const FVector& Location, const FRotator& Rotation)
{
	FlyFromLocation = CamLocation;
	FlyFromRotation = CamRotation;
	FlyToLocation = Location;
	FlyToRotation = Rotation;
	// The short way round.
	FlyToRotation.Yaw = FlyFromRotation.Yaw + FRotator::NormalizeAxis(FlyToRotation.Yaw - FlyFromRotation.Yaw);
	FlyT = 0.f;
	bFlying = true;
}

void AAetherBrainPlayerController::FlyToNode(int32 Index)
{
	AAetherBrainActor* B = Brain.Get();
	if (!B || !B->GetNode(Index))
	{
		return;
	}
	const FVector Node = B->NodeLocation(Index);
	const double Distance = FMath::Max(static_cast<double>(B->NodeRadius(Index)) * 9.0, 450.0);
	// Keep looking the way the camera looks, a little from above.
	FVector Back = (CamLocation - Node).GetSafeNormal();
	if (Back.IsNearlyZero())
	{
		Back = -FRotationMatrix(CamRotation).GetUnitAxis(EAxis::X);
	}
	Back = (Back + FVector(0.0, 0.0, 0.25)).GetSafeNormal();
	const FVector Where = Node + Back * Distance;
	FlyTo(Where, (Node - Where).Rotation());
}

void AAetherBrainPlayerController::FlyHome()
{
	AAetherBrainActor* B = Brain.Get();
	FVector Center;
	float Radius = 0.f;
	if (!B || !B->GetBounds(Center, Radius))
	{
		return;
	}
	const FVector Where = Center + FVector(-1.0, 0.0, 0.45).GetSafeNormal() * static_cast<double>(Radius) * 2.1;
	FlyTo(Where, (Center - Where).Rotation());
}
