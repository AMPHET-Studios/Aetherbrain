#include "AetherBrainPlayerController.h"

#include "AetherBrainActor.h"
#include "AetherFxActor.h"
#include "AetherSpaceActor.h"
#include "AetherVoyageActor.h"
#include "Camera/PlayerCameraManager.h"
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
	if (!Space.IsValid() && GetWorld())
	{
		for (TActorIterator<AAetherSpaceActor> It(GetWorld()); It; ++It)
		{
			Space = *It;
			break;
		}
	}
	if (!Fx.IsValid() && GetWorld())
	{
		for (TActorIterator<AAetherFxActor> It(GetWorld()); It; ++It)
		{
			Fx = *It;
			break;
		}
	}
	if (!Voyage.IsValid() && GetWorld())
	{
		for (TActorIterator<AAetherVoyageActor> It(GetWorld()); It; ++It)
		{
			Voyage = *It;
			break;
		}
	}
	if (AAetherSpaceActor* Sky = Space.Get())
	{
		if (WasInputKeyJustPressed(EKeys::B))
		{
			Sky->CycleMode();
		}
	}
	if (AAetherFxActor* Effects = Fx.Get())
	{
		if (WasInputKeyJustPressed(EKeys::N))
		{
			Effects->Toggle();
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

	// A voyage takes the controls: the interceptor flies the route, the camera chases it.
	if (AAetherVoyageActor* V = Voyage.Get())
	{
		if (WasInputKeyJustPressed(EKeys::V))
		{
			if (V->IsVoyaging())
			{
				LeaveVoyage();
			}
			else
			{
				StartVoyage();
			}
		}
		if (V->IsVoyaging())
		{
			VoyageTick(DeltaTime);
			if (APawn* P = GetPawn())
			{
				P->SetActorLocationAndRotation(CamLocation, CamRotation);
			}
			return;
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
	// A folder's picture card is far bigger than its sphere: the card under the cursor wins.
	if (!bLooking && Voyage.IsValid() && !Voyage->IsVoyaging())
	{
		const int32 Card = Voyage->PickCard(Origin, Direction);
		if (Card != INDEX_NONE)
		{
			Hovered = Card;
		}
	}
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

bool AAetherBrainPlayerController::HasVoyageNote() const
{
	return !VoyageNote.IsEmpty() && GetWorld() && GetWorld()->GetRealTimeSeconds() < VoyageNoteUntil;
}

int32 AAetherBrainPlayerController::ChooseVoyageTarget() const
{
	AAetherBrainActor* B = Brain.Get();
	if (!B)
	{
		return INDEX_NONE;
	}
	if (B->GetNode(B->GetSelected()))
	{
		return B->GetSelected();
	}
	if (B->GetNode(Hovered))
	{
		return Hovered;
	}
	// Otherwise the folder most in front of the camera, at least a short way off.
	const FVector Forward = FRotationMatrix(CamRotation).GetUnitAxis(EAxis::X);
	int32 Best = INDEX_NONE;
	double BestScore = -2.0;
	for (int32 I = 0; I < B->NumNodes(); ++I)
	{
		const FAetherNode* N = B->GetNode(I);
		if (!N || (N->Kind != EAetherKind::Sun && N->Kind != EAetherKind::Star && N->Kind != EAetherKind::Planet))
		{
			continue;
		}
		const FVector Rel = B->NodeTarget(I) - CamLocation;
		const double Dist = Rel.Size();
		if (Dist < 3000.0)
		{
			continue;
		}
		const double Score = FVector::DotProduct(Rel / Dist, Forward);
		if (Score > BestScore)
		{
			BestScore = Score;
			Best = I;
		}
	}
	return Best;
}

void AAetherBrainPlayerController::StartVoyage()
{
	AAetherVoyageActor* V = Voyage.Get();
	AAetherBrainActor* B = Brain.Get();
	if (!V || !B)
	{
		return;
	}
	const double Now = GetWorld() ? GetWorld()->GetRealTimeSeconds() : 0.0;
	const int32 Target = ChooseVoyageTarget();
	if (Target == INDEX_NONE || !V->BeginVoyage(CamLocation, Target))
	{
		VoyageNote = Target == INDEX_NONE ? TEXT("No folder to fly to: select one first.") : TEXT("You are already there: fly away a little, or pick another folder.");
		VoyageNoteUntil = Now + 4.0;
		return;
	}
	bFlying = false;
	Throttle = 1.f;
	if (PlayerCameraManager)
	{
		FovBeforeVoyage = PlayerCameraManager->GetFOVAngle();
	}
	B->SetHovered(INDEX_NONE);
	B->SelectNode(V->GetVoyageNode(), false);
	VoyageNote.Empty();
}

void AAetherBrainPlayerController::LeaveVoyage()
{
	if (AAetherVoyageActor* V = Voyage.Get())
	{
		V->EndVoyage();
	}
	if (PlayerCameraManager)
	{
		PlayerCameraManager->SetFOV(FovBeforeVoyage);
	}
	bFlying = false;
}

void AAetherBrainPlayerController::VoyageTick(float DeltaTime)
{
	AAetherVoyageActor* V = Voyage.Get();
	AAetherBrainActor* B = Brain.Get();
	if (!V)
	{
		return;
	}
	if (WasInputKeyJustPressed(EKeys::Escape) || WasInputKeyJustPressed(EKeys::RightMouseButton))
	{
		LeaveVoyage();
		return;
	}
	if (V->HasArrived() && WasInputKeyJustPressed(EKeys::Enter) && B && B->GetNode(V->GetVoyageNode()))
	{
		B->SelectNode(V->GetVoyageNode(), true);
	}
	// W and S set the speed, the wheel too.
	const float Dt = FMath::Min(DeltaTime, 0.1f);
	Throttle = FMath::Clamp(Throttle + ((IsInputKeyDown(EKeys::W) ? 1.f : 0.f) - (IsInputKeyDown(EKeys::S) ? 1.f : 0.f)) * 0.6f * Dt, 0.f, 1.f);
	if (WasInputKeyJustPressed(EKeys::MouseScrollUp))
	{
		Throttle = FMath::Min(1.f, Throttle + 0.1f);
	}
	if (WasInputKeyJustPressed(EKeys::MouseScrollDown))
	{
		Throttle = FMath::Max(0.f, Throttle - 0.1f);
	}
	FAetherVoyageInput In;
	In.Right = (IsInputKeyDown(EKeys::D) ? 1.f : 0.f) - (IsInputKeyDown(EKeys::A) ? 1.f : 0.f);
	In.Up = (IsInputKeyDown(EKeys::E) ? 1.f : 0.f) - (IsInputKeyDown(EKeys::Q) ? 1.f : 0.f);
	In.Throttle = Throttle;
	In.bFire = IsInputKeyDown(EKeys::LeftMouseButton) || IsInputKeyDown(EKeys::SpaceBar);
	FVector Origin;
	FVector Direction;
	if (DeprojectMousePositionToWorld(Origin, Direction))
	{
		In.bHasAim = true;
		In.AimDirection = Direction.GetSafeNormal();
	}
	V->StepVoyage(DeltaTime, In);
	FVector Loc;
	FRotator Rot;
	float Fov = 90.f;
	if (V->GetCamera(Loc, Rot, Fov))
	{
		CamLocation = Loc;
		CamRotation = Rot;
		if (PlayerCameraManager)
		{
			PlayerCameraManager->SetFOV(Fov);
		}
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
	// Where it will be drawn, not where it is on its way there (a node that has only just come in starts at its folder).
	const FVector Node = B->NodeTarget(Index);
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
